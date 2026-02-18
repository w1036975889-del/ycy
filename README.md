# ycy

ycyim

## 代码快速体检（2026-02）

当前仓库可以运行，但存在一些明显的工程化风险：

1. **缺少自动化测试与静态检查脚本**
   - `package.json` 里只有 `start`，没有 `test` / `lint` / `check`，后续改动容易回归。 
2. **后端文件过大且职责混杂**
   - `server.js` 同时承担 IM 客户端、HTTP API、WebSocket 会话、心跳、异常处理、以及一段前端 SDK 备份注释，维护成本较高。
3. **WebSocket 重连策略可优化**
   - 前端 SDK 当前是固定 3 秒重连，缺少最大重试间隔、抖动和手动停止机制，网络波动时容易反复打日志。
4. **配置验证较弱**
   - 关键变量（`API_BASE`、`PORT`、`GAME_CMD_TO` 等）未集中校验，部署错误可能在运行期才暴露。

## 如何让我“学会”官方开发者文档

最省心的方式是把文档放进仓库并明确告诉我入口：

1. 新建文档目录，例如 `docs/dev/official-guide.md`（或 PDF/HTML）。
2. 在 README 增加“文档入口”小节，写清楚：
   - 文档路径；
   - 文档版本号/日期；
   - 你希望我优先遵守的章节（例如“消息格式”“鉴权流程”“错误码”）。
3. 你在提需求时用一句模板即可：
   - `请先阅读 docs/dev/official-guide.md 的第 2、4、7 章，再修改 XXX 功能。`
4. 如果文档经常更新，建议再加一个 `docs/dev/CHANGELOG.md`，我就能先看增量再改代码。

> 只要文档在当前工作区可读，或你在对话里直接粘贴，我就可以按它执行；不需要“训练”步骤。

## 推荐下一步

- 补一个最小 `npm run check`（至少含 `node --check server.js`）。
- 把 `server.js` 拆分为 `im-client.js`、`ws-gateway.js`、`http-routes.js`。
- 给“官方协议字段”写一个 JSON Schema，发送前先校验。
