# Sound FOH

초보자를 위한 스피커 측정·자동 튜닝 프로그램 (Windows).

## 지금 되는 것 (2단계까지)
- 처음 화면과 초기 설정 화면, 실제 PC의 출력·입력 장치 목록
- 출력 장치 화면의 "테스트 음 듣기" (핑크 노이즈, 왼쪽 → 오른쪽)
- 입력 장치 화면과 소리 크기 화면의 실제 마이크 미터
- 소리 크기 화면의 "테스트 신호 재생" (양쪽 스피커, 측정과 같은 크기)
- 자동 측정: 방 소음 → L → R → L+R 스윕을 한 번에 재생하며 녹음, 주파수 응답과 도착 시간 계산
- 신뢰도 확인: 소리 크기, 찌그러짐, 방 소음 대비 신호 크기를 실제 값으로 판정
- 측정 결과 숫자는 `%APPDATA%\com.sfoh.app\measurements\`에 JSON으로 저장

결과 요약부터는 아직 견본입니다. 휴대폰 마이크는 휴대폰 앱이 생긴 뒤에 연결합니다.

## 설치 파일 받기
GitHub의 **Actions** 탭 → 가장 최근 "Windows 설치 파일 만들기" 실행 → 아래 **Artifacts**의 `SoundFOH-windows-installer`를 내려받아 압축을 풀고 `.exe`를 실행하세요.

## 구조
- `ui/` 화면 (HTML/JS, three.js 3D 방). `bridge.js`가 화면을 실제 오디오 엔진에 연결합니다.
- `ui/dsp.js` 측정 계산 (스윕, 디컨볼루션, 주파수 응답).
- `src-tauri/` 앱 본체 (Rust, Tauri 2). `src/audio.rs`가 장치 목록, 테스트 신호, 마이크 미터, 측정 재생·녹음을 담당합니다.

## 개발
```
npm install
npx tauri dev
```

## 크레딧
3D 모델 (CC BY 4.0, 크기와 방향을 조정함): Speaker Black Secondary (Orfeas41), Human head (ADAMA), Microphone (AlexC3D) — Sketchfab.
three.js (MIT).
