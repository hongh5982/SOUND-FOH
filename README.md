# Sound FOH

초보자를 위한 스피커 측정·자동 튜닝 프로그램 (Windows).

## 지금 되는 것 (4단계까지)
- 처음 화면과 초기 설정 화면, 실제 PC의 출력·입력 장치 목록
- 출력 장치 화면의 "테스트 음 듣기" (핑크 노이즈, 왼쪽 → 오른쪽)
- 입력 장치 화면과 소리 크기 화면의 실제 마이크 미터
- 소리 크기 화면의 "테스트 신호 재생" (양쪽 스피커, 측정과 같은 크기)
- 자동 측정: 방 소음 → L → R → L+R 스윕을 한 번에 재생하며 녹음, 주파수 응답과 도착 시간 계산
- 신뢰도 확인: 소리 크기, 찌그러짐, 방 소음 대비 신호 크기를 실제 값으로 판정
- 결과 요약과 자세히 보기(주파수, 위상, 임펄스, 잔향)를 실제 측정으로 계산 (`ui/analysis.js`)
- 측정 결과 숫자는 `%APPDATA%\com.sfoh.app\measurements\`에 JSON으로 저장
- 설치 파일이 Equalizer APO 1.4.2(공식 파일 그대로)를 조용히 함께 설치 (이미 있으면 건너뜀)
- 출력 장치를 고르면 그 장치에 Equalizer APO를 켬 (Windows 관리자 허락 1번, 오디오 서비스 재시작)
- 자동 튜닝 (`ui/tune.js`): L/R 따로 부푼 대역 컷(최대 -12 dB, 채널당 6개), 넓게 빈 곳만 +3 dB 이하로 올림(방 때문에 빈 곳은 안 올림), L/R 볼륨과 도착 시간 맞춤. 계산 → 적용 → 확인 측정을 최대 3번
- 보정은 Equalizer APO 설정 폴더의 `soundfoh.txt`에만 쓰고, `config.txt`에는 `Include: soundfoh.txt` 한 줄만 더함. 측정할 때는 이 파일을 비움
- 프로필은 `%APPDATA%\com.sfoh.app\profiles.json`에 저장, 프로필을 바꾸면 보정도 바뀜

음악 EQ 화면은 아직 견본입니다 (5단계). Equalizer APO 연결은 실제 Windows에서만 확인할 수 있습니다.

## 설치 파일 받기
GitHub의 **Actions** 탭 → 가장 최근 "Windows 설치 파일 만들기" 실행 → 아래 **Artifacts**의 `SoundFOH-windows-installer`를 내려받아 압축을 풀고 `.exe`를 실행하세요.

## 구조
- `ui/` 화면 (HTML/JS, three.js 3D 방). `bridge.js`가 화면을 실제 오디오 엔진에 연결합니다.
- `ui/dsp.js` 측정 계산 (스윕, 디컨볼루션, 주파수 응답). `ui/analysis.js` 문제 찾기. `ui/tune.js` 자동 튜닝 계산.
- `src-tauri/` 앱 본체 (Rust, Tauri 2). `src/audio.rs`가 장치 목록, 테스트 신호, 마이크 미터, 측정 재생·녹음을, `src/eapo.rs`가 Equalizer APO 연결을 담당합니다.
- `src-tauri/windows/hooks.nsh` 설치 파일에서 Equalizer APO를 함께 설치하는 부분.

## 개발
```
npm install
npx tauri dev
```

## 크레딧
3D 모델 (CC BY 4.0, 크기와 방향을 조정함): Speaker Black Secondary (Orfeas41), Human head (ADAMA), Microphone (AlexC3D) — Sketchfab.
three.js (MIT).
Equalizer APO (GNU GPL v2, https://sourceforge.net/projects/equalizerapo/) — 바꾸지 않고 함께 설치합니다.
