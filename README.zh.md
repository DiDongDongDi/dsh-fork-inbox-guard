# dsh-fork-inbox-guard

DeepSeek Harness host 插件：分叉出来的会话不再带上父会话里还没发出的队列。

父会话在某一轮还在跑时排进去的下一条，会先写成 `agent/inbox/spliced`，对应的出队发生在下一轮、切点之后。子会话把继承前缀重新折成 inbox，于是一打开就带着父会话的队列。官方从 `0.1.6` 起不再把切点之后的入队扫进来，但切点之前、本轮进行中排进去的消息仍然会跟着走。`0.2.2` 的 inbox 测试仍要求子会话保留这条 pending。本插件不改这条切点，只在子会话侧取消已经继承下来的队列项。

## 行为

- 监听 `agent/created`，并对插件装上时已经活着的 agent 补扫一次。
- 只取消「插入事件落在 `inheritedEventCount` 之前，且当前 inbox 里还拿着」的项，`next-turn` 和 `next-step` 都算。
- 普通会话（没有继承前缀）不动。子会话自己后来排进去的消息留着。对不上来源的项留着。
- 前缀读不出来、折取出错、或取消中途失败时停手，不猜。
- 不往对话里插说明。取消记成普通的 `agent/inbox/spliced`（`outcome: "canceled"`），重启后也不会回来。
- 父会话自己的队列不动。fork 出来的子 agent 同样处理。

## 安装

开发期（当前 web profile 用的就是这条）：

```json
"dsh-fork-inbox-guard": "file:/Users/kodyqywang/dsh-plugins-dev/dsh-fork-inbox-guard"
```

发布后：

```json
"dsh-fork-inbox-guard": "github:DiDongDongDi/dsh-fork-inbox-guard"
```

`dsh.profile.bundles` 追加 `"dsh-fork-inbox-guard"`，然后在 `~/.dsh/profiles/web` 执行 `pnpm update dsh-fork-inbox-guard`。重启 `dsh web`，浏览器硬刷新。

日志里成功时会有一行：

```text
[dsh-fork-inbox-guard] session-…: dropped N inherited prompt(s)
```

## 验证

在父会话里等回答还在生成时再发一条，让它留在队列里，然后从这一轮分叉。新会话的队列应是空的；在新会话里发的下一条应直接成为下一轮，而不是排在父会话那条后面。
