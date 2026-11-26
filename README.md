# S'FOH

초보자를 위한 스피커 측정·자동 튜닝 프로그램 (Windows).

## 지금 되는 것 (1단계)
- 처음 화면과 초기 설정 화면
- 실제 PC의 출력·입력 장치 목록
- 출력 장치 화면의 "테스트 음 듣기" (핑크 노이즈, 왼쪽 → 오른쪽)
- 입력 장치 화면의 실제 마이크 미터

측정 이후 화면은 아직 견본입니다.

## 설치 파일 받기
GitHub의 **Actions** 탭 → 가장 최근 "Windows 설치 파일 만들기" 실행 → 아래 **Artifacts**의 `SFOH-windows-installer`를 내려받아 압축을 풀고 `.exe`를 실행하세요.

## 구조
- `ui/` 화면 (HTML/JS, three.js 3D 방). `bridge.js`가 화면을 실제 오디오 엔진에 연결합니다.
- `src-tauri/` 앱 본체 (Rust, Tauri 2). `src/audio.rs`가 장치 목록, 테스트 음, 마이크 미터를 담당합니다.

## 개발
```
npm install
npx tauri dev
```

## 크레딧
3D 모델 (CC BY 4.0, 크기와 방향을 조정함): Speaker Black Secondary (Orfeas41), Human head (ADAMA), Microphone (AlexC3D) — Sketchfab.
three.js (MIT).
