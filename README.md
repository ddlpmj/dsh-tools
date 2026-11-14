# DSH 工具 · 脱敏源码包

适用于 DeepSeek Harness（DSH），已在宿主 0.2.2-rc.3 的独立环境中验证安装。下载 ZIP 解压，或克隆本仓库。安装时保留 `plugins/` 内的目录结构，便于知识库读取同级阅读助手的摘抄。

| 工具 | `plugins/` 下的目录 | 使用方式 |
| --- | --- | --- |
| AI 阅读助手 | `dsh-ai-reader` | 打开网页或粘贴文稿，保存文章与摘抄。AI 解读使用宿主的模型配置。 |
| 知识库 | `dsh-knowledge-base` | 在面板中点击初始化，再导入资料。编译与问答使用宿主的模型配置。 |
| AI 情报台 | `dsh-ai-intel` | 按需配置来源。运行本地采集需要 Python 3，微信公众号订阅可另配 RSS 服务。 |
| 对话收藏 | `dsh-conversation-saver` | 通过知识库保存当前 DSH 环境里的对话。请同时启用知识库。 |
| AI 大搜索 | `dsh-deep-search` | 按需使用 DSH 搜索、DeepSeek API 或 AnySearch，凭据由使用者配置。 |
| AI 访谈档案 | `dsh-ai-records` | 可手动添加内容与转写。订阅从空列表开始，定时同步默认关闭。 |

## 安装

在 DSH 左侧打开「插件 → 添加插件 → 安装第三方插件」，输入各插件目录的绝对路径。可以使用 `link:/绝对路径/dsh-tools/plugins/dsh-ai-reader` 这样的格式，逐个安装并启用。建议先安装阅读助手和知识库，再安装对话收藏。

有 `dsh` 命令的环境也可以在本目录执行以下命令。把 `desktop` 改成要安装到的 profile 名称。

```sh
dsh plugin --profile desktop add \
  "link:$PWD/plugins/dsh-ai-reader" \
  "link:$PWD/plugins/dsh-knowledge-base" \
  "link:$PWD/plugins/dsh-ai-intel" \
  "link:$PWD/plugins/dsh-conversation-saver" \
  "link:$PWD/plugins/dsh-deep-search" \
  "link:$PWD/plugins/dsh-ai-records"
```

如果当前 profile 已经安装了同名插件，它可能仍有自定义的数据路径。要从空库开始，可以在新 profile 里安装。启用后刷新界面，必要时重启 DSH。

## 本地数据与配置

插件默认使用 `~/Documents/DSH工具数据/` 下的各工具子目录。对话收藏使用知识库目录，并按需读取当前 DSH 环境里的会话。源码包里没有会话记录、知识库内容、阅读笔记、搜索历史、情报台资料、访谈归档或登录凭据。

- 情报台读取数据目录内的 `配置/信息源.json`（`{"sources":[]}`）和 `配置/实体表.json`（`{"entities":[]}`）。公众号采集服务可在宿主插件配置中填写 `wechatProviderFile`、`wechatProviderOrigin` 和 `wechatAllowedFeedOrigins`，再到面板完成授权。
- 访谈档案的订阅来源可在数据目录的 `sources.json` 中配置。播客条目填写 `id`、`name`、`kind: "podcast"` 和 `feed`。YouTube 频道使用 `kind: "youtube"`、`channel`，并需要本机安装 `yt-dlp`。使用云转写或对象存储时，在宿主插件配置中指向自己的 `asrKeyFile`、`ossEnvFile`。
