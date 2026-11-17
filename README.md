# Lecture Notes Pipeline

English | [中文](README.zh-CN.md)

An offline pipeline that turns English lecture recordings into structured Chinese study material:
transcript, bilingual summary, notes, glossary, mind map, Q&A cards and to-do items, all
cross-checked against the lecture slides. It was built for my own MSc lectures; this repository
contains the code only, not the lecture material. The UI, documentation and code comments are in
Chinese.

## Pipeline

```
recording (.m4a/.wav) ──► whisper.cpp transcription ──► transcript (.srt/.txt)
        │                 (chunked, optional speaker       │
        │                  diarization: tools/diarize.py,   ▼
        │                  sherpa-onnx)              LLM note generation (JSON)
        │                                                   │
slides (.pdf/.pptx) ──► import-slides.js / read-slides.js ──┤  check notes against slides
                        slides-extract.py                   ▼
                                                 notes page (.html, from shell.html)
                                                            │
                                pick-cards.js / sync-fsrs.js ▼
                                     flashcards for the English Learning Desk
```

## Components

- `make-notes.js`: the main pipeline (transcription, LLM calls, rendering, archiving). `--mock`
  renders built-in sample data without any network access.
- `import-slides.js`, `read-slides.js`, `slides-extract.py`: organise slides by course and date,
  extract their text and build a course map.
- `trim-transcript.js`, `fix-errata.js`, `fix-embedded-json.js`, `rematch-excluded.js`: transcript
  clean-up, error corrections and repair of malformed model output.
- `weekly-review.js`, `similar-courses.js`, `md-view.js`: weekly review page, links to related
  public courses, Markdown preview.
- `*.cmd`: one-click launchers for Windows.
- `sync-fsrs.js`: writes the generated cards to `../English Learning/notes-cards.js`, so the two
  projects are expected to sit side by side under those folder names.
- `_test-chunk.js`, `_verify-*.js`: tests and output checks. Some of them validate generated
  output and therefore need your own data.

## Quick start

Requirements: Windows, Node.js, [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with a
ggml model, and ffmpeg. Speaker diarization additionally needs Python and sherpa-onnx (optional).

```powershell
copy config.example.json config.json     # then point "model" at your ggml model
$env:DEEPSEEK_API_KEY = "..."            # the LLM key (see below)
node make-notes.js --check               # test the key and network
node make-notes.js --mock                # render sample notes offline
node make-notes.js "录音稿\your-transcript.txt"
```

Note generation calls the DeepSeek chat API (`deepseek-chat`), which the project was originally
built on in September 2026. The API key is read from `DEEPSEEK_API_KEY` or a local `.env` file and
is never stored in the repository.

## Privacy

Recordings, transcripts, notes, slides, timetables and logs are excluded via `.gitignore`. Course
codes in comments and documentation have been replaced with placeholders such as `DEMO1001M`, and
local paths with generic ones. Third-party models (the whisper ggml model and the sherpa-onnx
speaker model) are not bundled; download them from their respective projects.

## Related projects

- [notes-rag](https://github.com/JPZ-Brady/notes-rag): question answering over these notes with
  timestamped citations.
- [english-learning](https://github.com/JPZ-Brady/english-learning): the flashcard app that
  receives the generated cards.

## License

Released under the MIT License (see [LICENSE](LICENSE)).
