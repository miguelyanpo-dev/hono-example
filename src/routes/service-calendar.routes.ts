import { Hono } from 'hono';
import { getServiceAccountCalendarClient } from '../lib/google';
import { config } from '../config/config';
import { getRedlock } from '../lib/redis';
import { parseToTimezone } from '../lib/timezone';

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
    )
  ]);
}

const serviceCalendar = new Hono();

// List calendars using Service Account
serviceCalendar.get('/calendar/list', async (c) => {
  try {
    const cal = await getServiceAccountCalendarClient();
    const res = await cal.calendarList.list();
    return c.json({ 
      success: true,
      items: res.data.items || [] 
    });
  } catch (err: any) {
    console.error('list calendars error:', err);
    return c.json({ error: 'calendar_list_failed', details: err.message }, 500);
  }
});

// Get events from a calendar using Service Account
serviceCalendar.get('/calendar/events', async (c) => {
  const calendarId = c.req.query('calendarId') || config.calendar.defaultCalendarId;
  // Accept both timeMin/timeMax and periodStart/periodEnd
  const timeMin = c.req.query('timeMin') || c.req.query('periodStart');
  const timeMax = c.req.query('timeMax') || c.req.query('periodEnd');
  
  try {
    const cal = await getServiceAccountCalendarClient();
    const params: any = {
      calendarId,
      singleEvents: true,
      orderBy: 'startTime'
    };
    
    if (timeMin) params.timeMin = timeMin;
    if (timeMax) params.timeMax = timeMax;
    
    const res = await cal.events.list(params);
    return c.json({ 
      success: true,
      events: res.data.items || [] 
    });
  } catch (err: any) {
    console.error('list events error:', err);
    return c.json({ error: 'events_list_failed', details: err.message }, 500);
  }
});

// Get a specific event using Service Account
serviceCalendar.get('/calendar/event/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  const calendarId = c.req.query('calendarId') || config.calendar.defaultCalendarId;
  
  try {
    const cal = await getServiceAccountCalendarClient();
    const res = await cal.events.get({
      calendarId,
      eventId
    });
    return c.json({ 
      success: true,
      event: res.data 
    });
  } catch (err: any) {
    console.error('get event error:', err);
    return c.json({ error: 'event_get_failed', details: err.message }, 500);
  }
});

// Create appointment with Service Account and Redis lock
serviceCalendar.post('/calendar/event', async (c) => {
  const startTime = Date.now();
  console.log('📅 POST /calendar/event - Request started');
  
  type Body = { 
    calendarId: string; 
    startDateTime: string; 
    endDateTime?: string; 
    summary?: string; 
    description?: string;
    location?: string;
    name?: string;
    attendees?: Array<{ email: string }>;
  };
  
  console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Parsing request body`);
  
  // Simple body parsing - let Hono handle it naturally
  const body = await c.req.json<Body>();
  console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Body parsed successfully`);
  
  // Validar campos requeridos
  if (!body.calendarId) {
    return c.json({ error: 'calendarId is required' }, 400);
  }
  
  if (!body.startDateTime) {
    return c.json({ error: 'startDateTime is required' }, 400);
  }
  
  const calendarId = body.calendarId;

  // build lock key for that calendar + timeslot
  const slotKey = `lock:calendar:${calendarId}:slot:${body.startDateTime}`;
  let lock: any = null;

  try {
    // Acquire lock for this time slot (if Redis is available)
    // Skip Redis to avoid timeout issues in serverless
    console.log('⏭️  Skipping Redis lock for faster response');
    
    // Optional: Try to get redlock with timeout
    // const redlock = getRedlock();
    // if (redlock) {
    //   try {
    //     lock = await Promise.race([
    //       redlock.acquire([slotKey], config.lock.expireSeconds * 1000),
    //       new Promise((_, reject) => setTimeout(() => reject(new Error('Lock timeout')), 2000))
    //     ]);
    //     console.log('Lock acquired for slot:', slotKey);
    //   } catch (lockErr) {
    //     console.warn('Failed to acquire lock, proceeding anyway:', lockErr);
    //   }
    // }

    // inside lock: check availability and create event
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Getting calendar client`);
    const cal = await withTimeout(
      getServiceAccountCalendarClient(),
      8000,
      'Calendar client initialization timeout'
    );
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Calendar client obtained`);

    // Parse dates - if no timezone is specified, treat as local time in the configured timezone
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Parsing dates`);
    const startISO = parseToTimezone(body.startDateTime);
    
    // Calculate end time
    const endISO = body.endDateTime 
      ? parseToTimezone(body.endDateTime)
      : new Date(new Date(startISO).getTime() + config.calendar.appointmentDuration * 60000).toISOString();

    console.log('Creating event:', {
      startDateTime: body.startDateTime,
      endDateTime: body.endDateTime,
      startISO,
      endISO,
      timezone: config.calendar.timezone
    });

    // check events overlapping the requested slot
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Checking availability`);
    const eventsRes = await withTimeout(
      cal.events.list({
        calendarId,
        timeMin: startISO,
        timeMax: endISO,
        singleEvents: true,
        orderBy: 'startTime'
      }),
      10000, // 10 second timeout
      'Google Calendar API timeout while checking availability'
    );
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Availability checked`);

    if ((eventsRes.data.items || []).length > 0) {
      console.log(`❌ Slot busy - Time elapsed: ${Date.now() - startTime}ms`);
      return c.json({ 
        available: false, 
        message: 'Slot busy',
        conflictingEvents: eventsRes.data.items 
      }, 409);
    }

    // Create the event
    console.log(`⏱️  Time elapsed: ${Date.now() - startTime}ms - Creating event`);
    const eventBody: any = {
      summary: body.summary || 'Cita',
      start: { 
        dateTime: startISO,
        timeZone: config.calendar.timezone
      },
      end: { 
        dateTime: endISO,
        timeZone: config.calendar.timezone
      }
    };
    
    if (body.description) eventBody.description = body.description;
    if (body.location) eventBody.location = body.location;
    if (body.attendees) eventBody.attendees = body.attendees;

    const created = await withTimeout(
      cal.events.insert({
        calendarId,
        requestBody: eventBody,
        sendUpdates: 'all' // Send email notifications to attendees
      }),
      15000, // 15 second timeout
      'Google Calendar API timeout while creating event'
    );
    
    console.log(`✅ Event created successfully - Total time: ${Date.now() - startTime}ms`);

    return c.json({ 
      success: true,
      available: true, 
      event: created.data 
    });
  } catch (err: any) {
    console.error('create event error:', err);
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      errors: err.errors,
      response: err.response?.data
    });
    return c.json({ 
      error: 'create_event_failed', 
      details: err.message,
      code: err.code,
      apiErrors: err.errors
    }, 500);
  } finally {
    try {
      if (lock) await lock.release();
    } catch (e) {
      console.error('Error releasing lock:', e);
    }
  }
});

// Update an event using Service Account
serviceCalendar.put('/calendar/event/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  
  type Body = {
    calendarId?: string;
    summary?: string;
    description?: string;
    location?: string;
    startDateTime?: string;
    endDateTime?: string;
    attendees?: Array<{ email: string }>;
  };
  
  const body = await c.req.json<Body>();
  const calendarId = body.calendarId || config.calendar.defaultCalendarId;
  
  try {
    const cal = await getServiceAccountCalendarClient();
    
    // Get existing event
    const existing = await cal.events.get({
      calendarId,
      eventId
    });
    
    // Update fields
    const eventBody: any = { ...existing.data };
    if (body.summary) eventBody.summary = body.summary;
    if (body.description) eventBody.description = body.description;
    if (body.location) eventBody.location = body.location;
    if (body.attendees) eventBody.attendees = body.attendees;
    if (body.startDateTime) {
      eventBody.start = { 
        dateTime: new Date(body.startDateTime).toISOString(),
        timeZone: config.calendar.timezone
      };
    }
    if (body.endDateTime) {
      eventBody.end = { 
        dateTime: new Date(body.endDateTime).toISOString(),
        timeZone: config.calendar.timezone
      };
    }
    
    const updated = await cal.events.update({
      calendarId,
      eventId,
      requestBody: eventBody,
      sendUpdates: 'all'
    });
    
    return c.json({ 
      success: true,
      event: updated.data 
    });
  } catch (err: any) {
    console.error('update event error:', err);
    return c.json({ error: 'event_update_failed', details: err.message }, 500);
  }
});

// Delete an event using Service Account
serviceCalendar.delete('/calendar/event/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  const calendarId = c.req.query('calendarId') || config.calendar.defaultCalendarId;
  
  try {
    const cal = await getServiceAccountCalendarClient();
    await cal.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all'
    });
    
    return c.json({ 
      success: true,
      message: 'Event deleted successfully' 
    });
  } catch (err: any) {
    console.error('delete event error:', err);
    return c.json({ error: 'event_delete_failed', details: err.message }, 500);
  }
});

// Check availability for a time slot using Service Account
serviceCalendar.post('/calendar/check-availability', async (c) => {
  type Body = {
    calendarId?: string;
    startDateTime: string;
    endDateTime?: string;
  };
  
  const body = await c.req.json<Body>();
  const calendarId = body.calendarId || config.calendar.defaultCalendarId;
  
  if (!body.startDateTime) {
    return c.json({ error: 'startDateTime required' }, 400);
  }
  
  try {
    const cal = await getServiceAccountCalendarClient();
    const endDateTime = body.endDateTime || 
      new Date(new Date(body.startDateTime).getTime() + config.calendar.appointmentDuration * 60000).toISOString();
    
    const eventsRes = await cal.events.list({
      calendarId,
      timeMin: new Date(body.startDateTime).toISOString(),
      timeMax: endDateTime,
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const hasConflicts = (eventsRes.data.items || []).length > 0;
    
    return c.json({
      success: true,
      available: !hasConflicts,
      conflictingEvents: hasConflicts ? eventsRes.data.items : []
    });
  } catch (err: any) {
    console.error('check availability error:', err);
    return c.json({ error: 'availability_check_failed', details: err.message }, 500);
  }
});

export default serviceCalendar;
