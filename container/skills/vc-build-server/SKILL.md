---
name: vc-build-server
description: Use when building or testing vouchercloud projects inside a NanoClaw container. The container is Linux and cannot run msbuild/nuget/dotnet directly — use this skill instead of vc-build-commands.
---

# Vouchercloud Build Server

NanoClaw agents run on Linux and cannot execute `msbuild`, `nuget`, or `dotnet vstest` directly. All builds and tests go through the Windows build server at `http://host.docker.internal:8120`.

Auth header required on all endpoints:
```
Authorization: Bearer e36ab61f-65a1-4f41-97e9-c2cda230cea3
```

## Build

```bash
curl -s -X POST http://host.docker.internal:8120/build \
  -H "Authorization: Bearer e36ab61f-65a1-4f41-97e9-c2cda230cea3" \
  -H "Content-Type: application/json" \
  -d '{"project": "vouchercloud/<repo>"}'
# Returns: {"job_id": "..."}
```

## Test

```bash
curl -s -X POST http://host.docker.internal:8120/test \
  -H "Authorization: Bearer e36ab61f-65a1-4f41-97e9-c2cda230cea3" \
  -H "Content-Type: application/json" \
  -d '{"project": "vouchercloud/<repo>", "test_projects": [...], "filter": "...", "build_first": true}'
# Returns: {"job_id": "..."}
```

`test_projects` and `filter` are optional. `build_first` defaults to true.

### coupons-cc test config
```json
{
  "project": "vouchercloud/coupons-cc",
  "test_projects": ["IDL.Api.ControlCloud.UnitTests", "IDL.Web.ControlCloud.UnitTests"],
  "filter": "FullyQualifiedName!~Blog"
}
```

## Polling

Poll `GET /job/{job_id}` every 5 seconds until `status == "done"`:

```bash
curl -s http://host.docker.internal:8120/job/{job_id} \
  -H "Authorization: Bearer e36ab61f-65a1-4f41-97e9-c2cda230cea3"
# Returns: {"job_id": "...", "status": "running|done", "success": null|true|false, "output": "..."}
```

`success` is `null` while running, `true`/`false` when done. Report `success` and relevant lines from `output`.

## Project Names

| Repo | project value |
|------|--------------|
| coupons-cc | `vouchercloud/coupons-cc` |
| vouchercloud-idl | `vouchercloud/vouchercloud-idl` |
| coupons-scheduled-task-service | `vouchercloud/coupons-scheduled-task-service` |
| coupons-replicator | `vouchercloud/coupons-replicator` |
| coupons-core | `vouchercloud/coupons-core` |
| coupons-shared | `vouchercloud/coupons-shared` |
