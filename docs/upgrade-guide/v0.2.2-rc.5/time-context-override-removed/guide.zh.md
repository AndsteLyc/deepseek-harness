---
kind: upgrade-guide
description: "time-context 插件移除 overrideTimeZone，standard 预设改为跟随浏览器时区。"
---

# `time-context` 移除 `overrideTimeZone`

[English](guide.md) | 中文

## 变更

`standard` 预设原先通过 `overrideTimeZone` 按 `Asia/Singapore` 格式化时钟读数。现在，当轮次只上报一个浏览器时区时，插件按该时区格式化读数。时区缺失或混杂时，插件使用 `timeZone` 或 Host 进程时区。

## 迁移

1. 如果你的 `cordis.yml` 或 `cordis.patch.yml` 为 `@deepseek-ai/dsh-time-context` 配置了 `overrideTimeZone`，请移除此键，包括预设覆盖中的同名配置。仅在需要设置回退时区时使用 `timeZone`。
2. 在新的 `standard` 会话中发送一条消息，确认新生成的 `time-context` 读数标注了该浏览器上报的时区。
