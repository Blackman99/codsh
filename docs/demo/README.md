# /ship demo cut

There is no uncut live-session master in this repo. What exists:

- `assets/ship-demo.gif` / `assets/ship-demo.zh.gif` — real binary frames, timed animation
- `assets/codsh-ship-demo.zh.mp4` — 70.2s 1080p cut of that animation + Chinese VO
- `assets/codsh-ship-demo.zh.srt` — Chinese captions, locked to that cut
- `assets/codsh-ship-demo.en.srt` — English captions, same timestamps

A live `/ship` against a real model is not in git. Record it on the machine that has `DEEPSEEK_API_KEY`.

## Burn captions onto the existing Chinese cut

```sh
ffmpeg -y -i assets/codsh-ship-demo.zh.mp4 \
  -vf "subtitles=assets/codsh-ship-demo.zh.srt:force_style='FontName=PingFang SC,FontSize=20,Outline=1.4,Shadow=0,MarginV=36,PrimaryColour=&H00FFFFFF&'" \
  -c:a copy assets/codsh-ship-demo.zh.subs.mp4
```

English cut from the same picture (captions only, keep the Chinese VO until you replace audio):

```sh
ffmpeg -y -i assets/codsh-ship-demo.zh.mp4 \
  -vf "subtitles=assets/codsh-ship-demo.en.srt:force_style='FontName=Helvetica,FontSize=20,Outline=1.4,Shadow=0,MarginV=36,PrimaryColour=&H00FFFFFF&'" \
  -c:a copy assets/codsh-ship-demo.en.subs.mp4
```

Replace audio with a new English VO (`vo-en.wav`, same length):

```sh
ffmpeg -y -i assets/codsh-ship-demo.zh.mp4 -i vo-en.wav \
  -map 0:v -map 1:a -c:v copy -c:a aac -shortest \
  -vf "subtitles=assets/codsh-ship-demo.en.srt:force_style='FontName=Helvetica,FontSize=20,Outline=1.4,MarginV=36'" \
  assets/codsh-ship-demo.en.mp4
```

## Live session (the real one)

1. Tiny fixture repo: one file, one `node --test`, dirty-free tree.
2. `/thinking low`. Answers for Grill written before you hit record.
3. OBS: terminal only, 1920×1080, font ≥ 16.
4. Keep Grill / Gate 1 / Gate 2 / Deliver at 1×. Ramp thinking, tools, tests 8–16×.
5. Corner bug: `×8 · live session · wall clock mm:ss`.
6. Voiceover after the cut, never live. Lay `*.srt` on the new timeline — do not reuse the 70s file.
