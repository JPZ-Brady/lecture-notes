# 课堂笔记流水线（Lecture Notes Pipeline）

[English](README.md) | 中文

一条离线运行的流水线，把英文课堂录音整理成结构化的中文学习材料：字幕稿、中英双语摘要、笔记、术语表、思维导图、问答卡片和待办事项，并全部对照课件进行核对。项目为我自己的硕士课程而建；本仓库只包含代码，不包含课堂材料。界面、文档和代码注释均为中文。

## 流水线

```
录音 (.m4a/.wav) ──► whisper.cpp 转写 ──► 字幕稿 (.srt/.txt)
        │            （分段处理，可选说话人       │
        │             区分：tools/diarize.py，    ▼
        │             sherpa-onnx）         大模型生成笔记 (JSON)
        │                                        │
课件 (.pdf/.pptx) ──► import-slides.js / read-slides.js ──┤  对照课件检查笔记
                      slides-extract.py                  ▼
                                              笔记网页 (.html，由 shell.html 生成)
                                                         │
                             pick-cards.js / sync-fsrs.js ▼
                                  English Learning 学习台的背词卡片
```

## 组成部分

- `make-notes.js`：主流程（转写、调用大模型、生成网页、归档）。`--mock` 不联网，用内置示例数据生成网页。
- `import-slides.js`、`read-slides.js`、`slides-extract.py`：按课程和日期整理课件、提取文字、生成课程地图。
- `trim-transcript.js`、`fix-errata.js`、`fix-embedded-json.js`、`rematch-excluded.js`：清理字幕稿、套用勘误、修复格式有误的模型输出。
- `weekly-review.js`、`similar-courses.js`、`md-view.js`：每周复习页、相关公开课链接、Markdown 预览。
- `*.cmd`：Windows 下的一键启动脚本。
- `sync-fsrs.js`：把生成的卡片写入 `../English Learning/notes-cards.js`，因此两个项目需要以这两个文件夹名并排存放。
- `_test-chunk.js`、`_verify-*.js`：测试和输出检查。其中一部分检查的是生成结果，需要你自己的数据才能运行。

## 快速开始

需要：Windows、Node.js、[whisper.cpp](https://github.com/ggerganov/whisper.cpp) 及一个 ggml 模型、ffmpeg。说话人区分另需 Python 和 sherpa-onnx（可选）。

```powershell
copy config.example.json config.json     # 然后把 "model" 改成你的 ggml 模型路径
$env:DEEPSEEK_API_KEY = "..."            # 大模型的 Key（见下文）
node make-notes.js --check               # 测试 Key 和网络
node make-notes.js --mock                # 离线生成示例笔记
node make-notes.js "录音稿\your-transcript.txt"
```

笔记生成调用的是 DeepSeek 对话接口（`deepseek-chat`），这是项目 2026 年 9 月最初搭建时所用的模型。API Key 从环境变量 `DEEPSEEK_API_KEY` 或本地 `.env` 文件读取，从不存入仓库。

## 隐私

录音、字幕稿、笔记、课件、课表和日志均通过 `.gitignore` 排除。注释和文档中的课程代码已替换为 `DEMO1001M` 这类占位符，本地路径也已替换为通用路径。第三方模型（whisper 的 ggml 模型和 sherpa-onnx 的说话人模型）不随仓库提供，请从各自的项目下载。

## 相关项目

- [notes-rag](https://github.com/JPZ-Brady/notes-rag)：对这些笔记进行问答，回答带时间点出处。
- [english-learning](https://github.com/JPZ-Brady/english-learning)：接收生成卡片的背词应用。

## 许可证

采用 MIT 许可证（见 [LICENSE](LICENSE)）。
