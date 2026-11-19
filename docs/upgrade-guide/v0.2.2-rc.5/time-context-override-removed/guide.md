---
kind: upgrade-guide
description: "The time-context plugin removes overrideTimeZone and the standard preset follows the browser time zone."
---

# `time-context` removes `overrideTimeZone`

English | [中文](guide.zh.md)

## Change

The `standard` preset used to format clock readings in `Asia/Singapore` through `overrideTimeZone`. The plugin now formats readings in the browser time zone when the turn reports exactly one zone. When the zone is missing or mixed, the plugin uses `timeZone` or the Host process time zone.

## Migration

1. If your `cordis.yml` or `cordis.patch.yml` configures `@deepseek-ai/dsh-time-context` with `overrideTimeZone`, remove that key, including from any preset override. Use `timeZone` only to set the fallback.
2. Send a message in a new `standard` session and check that a new `time-context` reading names the time zone reported by that browser.
