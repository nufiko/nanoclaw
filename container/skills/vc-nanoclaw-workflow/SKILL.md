---
name: vc-nanoclaw-workflow
description: Use when starting a Vouchercloud ticket workflow from within a NanoClaw container. Use instead of vc-ticket-workflow when running inside NanoClaw.
---

# VC Ticket Workflow (NanoClaw)

Follow the `vc-ticket-workflow` skill exactly, with one override:

**For ALL build and test steps, use `vc-build-server` instead of `vc-build-commands`.**

The NanoClaw container is Linux — `msbuild`, `nuget`, and `dotnet vstest` are not available. The `vc-build-server` skill documents how to trigger builds and tests via the Windows build server API and poll for results.

Everything else from `vc-ticket-workflow` applies unchanged: phases, approval gates, branch setup, commits, PRs, post-PR steps, and knowledge base updates.
