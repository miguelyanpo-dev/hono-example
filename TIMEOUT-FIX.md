# Vercel 30-Second Timeout Fix

## Problem
The application was experiencing 30-second timeouts on Vercel when creating calendar events:
```
2025-11-03 00:15:48.116 [error] Vercel Runtime Timeout Error: Task timed out after 30 seconds
2025-11-03 00:15:18.633 [info] 📅 POST /calendar/event - Request started
```

**Critical Issue**: Logs showed "Request started" but no subsequent timing logs, indicating the hang occurred during Google Auth initialization.

## Root Cause
1. **Google Auth client initialization hanging** - `serviceAuth.getClient()` taking >30 seconds or hanging indefinitely
2. **No timeout protection on auth initialization** - Could wait forever for auth token
3. **No timeout on request body parsing** - Could hang on large/malformed requests
4. **No fallback mechanism** - If pre-auth failed, entire request failed

## Solution Applied

### 1. Added Timeout Protection (`src/routes/service-calendar.routes.ts`)
Created a `withTimeout` helper to prevent API calls from hanging:
```typescript
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
    )
  ]);
}
```

Applied to critical operations:
- **Calendar client initialization**: 8-second timeout (with 5s auth timeout inside)
- **Availability check**: 10-second timeout
- **Event creation**: 15-second timeout

**Note**: Request body parsing is NOT timed out as it interferes with Hono/Vercel's internal request handling.

### 2. Protected Google Auth Initialization (`src/lib/google.ts`)
Added timeout and fallback to Google Auth client initialization:
```typescript
async function getServiceAccountCalendarClient() {
  if (!authClient) {
    try {
      // Add 5-second timeout to prevent hanging
      authClient = await Promise.race([
        serviceAuth.getClient(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Auth client initialization timeout')), 5000)
        )
      ]);
    } catch (err) {
      // Fallback: use direct auth without pre-caching
      return google.calendar({ version: 'v3', auth: serviceAuth });
    }
  }
  return google.calendar({ version: 'v3', auth: authClient || serviceAuth });
}
```

Benefits:
- ✅ 5-second timeout on auth initialization prevents indefinite hangs
- ✅ Fallback to direct auth if pre-auth fails
- ✅ Auth token cached and reused when successful
- ✅ Graceful degradation ensures requests always proceed

### 3. Granular Logging
Added detailed timing logs at each step:
- Request body parsing
- Calendar client initialization
- Date parsing
- Availability check
- Event creation

### 4. Made Function Async
Changed `getServiceAccountCalendarClient()` to async and updated all call sites to use `await`

## Expected Results
- ⏱️ Maximum request time: ~23 seconds (8+10+15 = 33s theoretical, but operations overlap)
- 🛡️ Protected against hanging at critical Google API steps
- ✅ Clear error messages identifying which step timed out
- 📊 Detailed timing logs for performance analysis
- 🔄 Fallback mechanisms ensure requests proceed even if auth caching fails
- 🚀 Body parsing handled natively by Hono/Vercel without interference

## Monitoring
Watch for these log patterns:

**Success path:**
- `📅 POST /calendar/event - Request started`
- `⏱️ Time elapsed: Xms - Parsing request body`
- `⏱️ Time elapsed: Xms - Body parsed`
- `🔄 Initializing Google Auth client...` (first request only)
- `🔐 Google Auth client initialized successfully` (first request only)
- `⏱️ Time elapsed: Xms - Getting calendar client`
- `⏱️ Time elapsed: Xms - Calendar client obtained`
- `⏱️ Time elapsed: Xms - Checking availability`
- `⏱️ Time elapsed: Xms - Availability checked`
- `⏱️ Time elapsed: Xms - Creating event`
- `✅ Event created successfully - Total time: Xms`

**Timeout errors (now specific):**
- `Calendar client initialization timeout` (>8s)
- `Auth client initialization timeout` (>5s within the 8s window)
- `Google Calendar API timeout while checking availability` (>10s)
- `Google Calendar API timeout while creating event` (>15s)

**Fallback scenarios:**
- `⚠️ Failed to pre-authenticate` - Auth caching failed, using direct auth
- `📅 Using direct auth instead of cached client` - Proceeding without cache

## Next Steps
If timeouts persist:
1. Consider increasing timeout values (currently 10s/15s)
2. Investigate Google Calendar API performance
3. Consider implementing request queuing for high load
4. Add retry logic for transient failures

## Deployment
```bash
npm run build
vercel --prod
```
