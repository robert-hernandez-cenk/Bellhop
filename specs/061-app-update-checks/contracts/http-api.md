# HTTP API Contract

All routes sit behind the global `requireAuth` and impersonation overlay.

## GET /api/tasks  (admin: `requireAdminGroup`)

200:

```json
{
  "tasks": [
    {
      "id": "check-app-updates",
      "label": "App update check",
      "description": "Checks each LXC guest's community-scripts app for a newer upstream release.",
      "timeOfDay": "04:00",
      "defaultTime": "04:00",
      "enabled": true,
      "running": false,
      "lastRun": { "startedAt": "2026-10-03T04:00:05.000Z", "jobId": 812, "status": "success" },
      "nextRun": "2026-10-04T04:00:00.000Z"
    }
  ]
}
```

`lastRun` is `null` if the task has never run. `lastRun.status` is `null` when the job row no longer exists. `nextRun` is `null` when the task is disabled. When no scheduler is wired (tests only), the response is 503 `{ "error": "Task scheduler is not running in this process" }`.

## PATCH /api/tasks/:id  (admin)

Body (zod, strict, at least one field): `{ "timeOfDay"?: "HH:MM", "enabled"?: boolean }`.

- 200: the updated task object, same shape as above.
- 400: `{ "error": "timeOfDay must be HH:MM in 24-hour time, e.g. 04:00" }`, or another validation message. Nothing is saved.
- 404: `{ "error": "Unknown task: <id>" }`.

## POST /api/tasks/:id/run  (admin)

- 200: `{ "jobId": 813 }`. The job is attributed through `resolveTriggeredBy(req)`.
- 409: `{ "error": "App update check is already running (job #812)" }`.
- 404: unknown task.

## GET /api/app-updates  (any authenticated user)

200:

```json
{
  "results": [
    {
      "guest": "media",
      "app": "jellyseerr",
      "status": "update-available",
      "installedVersion": "1.2.3",
      "latestVersion": "1.3.0",
      "repo": "example-owner/example-app",
      "checkedAt": "2026-10-03T04:00:41.000Z"
    },
    {
      "guest": "web-lxc",
      "app": "homepage",
      "status": "error",
      "message": "GitHub API rate limit reached; the next scheduled check will retry",
      "checkedAt": "2026-10-03T04:00:42.000Z"
    }
  ]
}
```

A row is included only when its guest is an `lxc` guest with an `app` in the current inventory **and** `isResourceAllowed(rules, caller, 'guest', guest)` holds (FR-026). Optional fields are omitted when null.
