# Invest

Invest 是一个给个人查看资产价格、管理资产总额的小工具。它把自选行情、持仓估值、K 线和金融日历放在同一个轻量 Web 应用中，数据保存在你自己的 SQLite 文件里。

## 主要功能

- 自选资产：按市场和标签管理美股、港股、A 股、加密货币和指数。
- 行情概览：定时刷新报价，支持搜索、排序、手动刷新和资产详情。
- K 线：日线、周线、月线切换，以及基础缩放和十字线查看。
- 资产管理：维护渠道、资产类型和持仓数量，汇总个人资产估值。
- 金融日历：接入金十 MCP 后查看金融事件；移动端显示周视图，桌面端显示月视图。
- 响应式界面：同时适配桌面和移动浏览器。

## 快速开始

需要 Node.js 22.5 或更高版本。

```bash
git clone https://github.com/xiezhaoye/invest.git
cd invest
cp .env.example .env
npm ci
npm run start:local
```

编辑 `.env`，至少设置一组浏览器登录凭据：

```dotenv
INVEST_AUTH_USER=your-name
INVEST_AUTH_PASS=use-a-long-unique-password
```

然后访问 `http://127.0.0.1:8787`。如需让其他程序调用 API，再生成并设置 `INVEST_API_TOKEN`：

```bash
openssl rand -hex 32
```

运行测试：

```bash
npm test
```

### Docker

```bash
cp .env.example .env
# 编辑 .env，填写 INVEST_AUTH_USER 和 INVEST_AUTH_PASS
docker compose up -d --build
```

默认端口为 `8787`；可在 `.env` 中用 `INVEST_PORT` 改变宿主机映射端口。数据库会持久化在项目目录的 `data/` 下，该目录不会提交到 Git。

## 金十金融日历

金融日历需要你拥有可用的金十 MCP Key。在 `.env` 设置：

```dotenv
JIN10_MCP_TOKEN=your-key
```

重启服务后即可使用。密钥只由服务端读取，不会传给浏览器，也不应提交到 Git。

## 使用限制

1. 金融日历依赖金十 MCP Key；没有配置时，日历无法获取事件。
2. 行情并非实时交易终端数据。自选报价默认每 10 分钟刷新；日线缓存至少 10 分钟，周线至少 4 小时，月线至少 24 小时。上游数据源的延迟、休市和限流也会影响显示。
3. 添加非标类资产时，若没有可识别的行情代码或数据源支持，可能无法直接添加或自动估值。

## 使用建议

最推荐的方式是克隆项目，在本地运行，并使用 AI 按你的资产类别、数据源、布局和工作流继续定制。这样你的数据和凭据始终由自己掌控，也更适合个人资产管理场景。

## 免责声明

本项目仅供个人信息管理和学习使用，不构成任何投资建议。市场数据可能延迟、不完整或有误，请自行核实并独立作出投资决策。

## License

[MIT](LICENSE)
