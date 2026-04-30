#

- agent双层循环机制
- system_prompt动态组装
- 两种消息模式->ui/用户
- 记忆系统->参考claude code

- 现在迭代次数100，参考pi-mono去掉限制

- Agent Loop: messages快照，支持工具通过 terminate: true 主动终止循环。streaming 开始时就把 partialMessage push 进 context.messages，并在每个 delta 时原地更新。stopReason: "length" 是一等公民，在 AgentMessage 里明确记录，UI 层可以响应。
- pi-mono Context 管理
- pi-mono AgentTool，工具支持流式进度更新，工具结果支持 terminate hint
- pi-mono AgentMessage可扩展
- 处理max_tokens，参考pi_mono的模型 max_tokens传入，默认值计算，thinking补偿模式，调用方覆盖，截断检测


- Terminal-Bench 2.0评估


- 参考文档
    - https://zhanghandong.github.io/pi-book
    - https://zhuanlan.zhihu.com/p/2009697625939658120


