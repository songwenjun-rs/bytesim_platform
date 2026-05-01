# bytesim — ByteSim Platform SDK + CLI

ByteSim 平台的 Python 客户端。一份代码两种用法：脚本 / notebook 用 `Client`，shell / CI 用 `bytesim`。

## 安装

```bash
pip install -e ./sdk            # 开发版
# 内部 PyPI 上线后：pip install bytesim
```

安装后 `bytesim` 命令立即可用，`from bytesim import Client` 也即时可用。两边共享同一个 `~/.bytesim/config.toml`，所以 shell 里 `bytesim login` 之后 notebook 里 `Client()` 直接可用。

## 5 分钟首单

```bash
bytesim login songwenjun --base-url http://bytesim.internal:8080
bytesim whoami
bytesim project list
bytesim run list --status running
bytesim run create \
    --hwspec-hash 0000000000000000000000000000000000000004 \
    --model-hash  0000000000000000000000000000000000000102 \
    --title "我的第一个 Run"
bytesim run tail sim-XXXX        # 跟踪 engine.log
bytesim spec diff hwspec hwspec_topo_b1 v3 v4
```

所有命令支持 `--format json`，配 `jq` 可做 shell 管道：

```bash
bytesim run list --status running --format json | jq '.[].id'
```

## SDK 用法（notebook / 脚本）

```python
from bytesim import Client

c = Client()                          # 读 ~/.bytesim/config.toml
print(c.whoami())                     # → {actor_id, project_id, projects}

# Runs
runs = c.runs.list(status="running")
detail = c.runs.get_full("sim-7f2a")  # run + specs + lineage
new = c.runs.create(hwspec_hash="...", model_hash="...", title="...")
c.runs.cancel("sim-XXXX")

# Specs
spec = c.specs.get("hwspec", "hwspec_topo_b1")
diff = c.specs.diff("hwspec", "hwspec_topo_b1", from_hash="...", to_hash="...")
forked = c.specs.fork("hwspec", "hwspec_topo_b1", new_name="my-fork")

# 跨项目（不刷页面）
c.use_project("p_lab")
```

## 配置

`~/.bytesim/config.toml`（`bytesim login` 自动创建，权限 0600）：

```toml
base_url = "http://bytesim.internal:8080"
token    = "..."
project  = "p_default"
actor_id = "songwenjun"
```

环境变量优先级高于文件，CI 友好：

```
BYTESIM_BASE_URL  → base_url
BYTESIM_TOKEN     → token
BYTESIM_PROJECT   → project
BYTESIM_PASSWORD  → 用于 `bytesim login --password $BYTESIM_PASSWORD`
```

## 错误处理

```python
from bytesim import Client, ApiError, AuthError, NotFoundError

try:
    c = Client()
    c.runs.get("ghost")
except NotFoundError:
    print("Run 不存在")
except AuthError:
    print("token 失效，去 `bytesim login`")
except ApiError as e:
    print(f"API 错误 {e.status}: {e.body}")
```

## 跟前端 / 其它服务的关系

CLI/SDK 只通过 BFF（`/v1/*`）说话，不直接连 PG / 各微服务。所有路径都跟前端 SPA 一一对应，所以**前端能做的，CLI 都能做**——slice-15 的 JWT + X-Project-ID 两个 header 在 CLI 也是这套机制，token 可在浏览器和 CLI 之间互通（虽然实际更建议各自 `login`，方便过期管理）。

## 当前命令一览

| 命令 | 说明 |
|---|---|
| `bytesim login <user_id>` | 登录，token 落 ~/.bytesim/config.toml |
| `bytesim logout` | 清 token（保留 base_url、project） |
| `bytesim whoami` | 当前 actor + 可访问项目 |
| `bytesim config show` | 打印当前配置（token 截断显示） |
| `bytesim project list` | 列出当前 actor 可访问的项目 |
| `bytesim project switch <id>` | 切默认项目 |
| `bytesim run list/get/create/cancel/kick/tail` | Run 全生命周期 |
| `bytesim spec get/versions/diff/fork/snapshot` | Spec（hwspec/model/strategy/workload）治理 |

```text
bytesim --help          # 顶层帮助
bytesim run --help      # 子命令帮助
```

## 开发与测试

```bash
# 安装到 venv
.venv-test/bin/pip install -e ./sdk

# 跑 SDK 测试套（uvicorn 拉一个 BFF 实例 + httpx）
.venv-test/bin/pytest tests/sdk -v
```

测试是真 e2e：`tests/sdk/conftest.py` 在线程里跑了一份 BFF 应用，SDK 通过本地 socket 真请求过去。捕获了所有"SDK 跟 BFF 路径/payload 不对"的 bug。

## 切片 16 之后

下一阶段（参考产品规划）：

- **Slack/Lark bot**：把 `bytesim run create/tail/cancel` 包成 IM 命令
- **数据接入**：`bytesim import-trace ./profiler.json --as workload my-train` 从真实训练 trace 反向生成 workload spec
- **跟训练平台双向桥接**：`bytesim run create --submit-to-train-platform`
- **CLI 任务化**：`bytesim playbook run weekly-baseline` 跑预定义 DAG
