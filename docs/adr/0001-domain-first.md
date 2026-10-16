# Domain owns insurance meaning

按 Domain-first 组织现有代码：`src/domain/` 拥有身份核验、案件事实与期限、材料要求以及咨询状态的模型和不变量；`src/application/` 使用这些模型定义用例契约和外部能力需求；`src/adapters/` 翻译 fixture 格式并接入 Pi。依赖指向 domain，domain 使用纯 TypeScript，业务测试可直接跨其 interface 验证规则。

原先 fixtures adapter 同时解释材料名称、原件要求和期限，容易让业务含义随数据来源改变；集中这些规则后，各 adapter 复用相同含义。保留单一理赔咨询上下文，按已有业务概念划分 module，具体业务约束及关键测试先于后续工具、存储和界面实现。
