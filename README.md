# 💳 corpcard-audit-mcp-server

**AI가 법인카드 이상징후 탐지 시나리오를 만들고, 룰 엔진이 전 거래를 자동 분석하는 MCP 서버**

*An MCP server that turns Claude into your corporate-card audit assistant — AI generates detection scenarios from your data, a deterministic rule engine runs them across every transaction.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blueviolet)](https://modelcontextprotocol.io)
[![CI](https://github.com/fbaudit/corpcard_audit/actions/workflows/ci.yml/badge.svg)](https://github.com/fbaudit/corpcard_audit/actions/workflows/ci.yml)

---

## 왜 만들었나요?

대부분의 기업 내부감사인은 아직도 **엑셀 필터와 눈**으로 법인카드 사용내역을 점검합니다. 심야 사용, 주말·공휴일 사용, 분할결제, 한도 회피, 유흥업종… 매달 반복되는 이 작업에 감사인의 시간이 더 이상 쓰이지 않았으면 합니다.

이 MCP 서버를 Claude에 연결하면 대화만으로 다음이 끝납니다:

```
👤 "카드내역.xlsx 불러와서 이상징후 시나리오 10개 만들어줘"

🤖 corpcard_load_data      → 3,842건 로드, 첫 번째 필드(카드번호) 기준 프로파일링
🤖 corpcard_generate_scenarios → AI가 데이터 스키마·통계에 맞춘 시나리오 10개 생성
                              → 생성 즉시 전체 거래 자동 분석
   S1. 심야(22~06시) 사용            🔴 high   — 17건
   S2. 동일 가맹점 당일 분할결제       🔴 high   — 4건
   S3. 주말·공휴일 사용              🟠 medium — 63건
   S4. 유흥·골프·상품권 업종         🔴 high   — 9건
   S5. 카드별 월 사용액 상위 이상치    🟠 medium — 3건
   ...

👤 "S2 상세 보여주고 보고서로 저장해줘"

🤖 corpcard_get_anomalies → 분할결제 의심 거래 상세 (행 번호·사유 포함)
🤖 corpcard_export_report → corpcard_audit_report.md / .csv 저장
```

## ✨ 특징

- **첫 번째 필드 기준 시나리오 생성** — 데이터의 첫 컬럼(카드번호·사원번호 등, 한글/영문 무관)의 값 분포를 기준으로 AI가 감사 관점의 탐지 시나리오를 **원하는 개수만큼** 생성
- **자동 분석** — 데이터가 로드되어 있으면 시나리오 생성/추가 즉시 전체 거래에 자동 적용되어 이상탐지건 리스트가 바로 출력
- **AI는 설계만, 판정은 룰 엔진이** — AI는 실행 가능한 룰(JSON DSL)을 설계하고, 결정론적 룰 엔진이 전 거래를 평가 → 결과가 재현 가능하고 감사 증적으로 사용 가능
- **한국 실무 최적화** — CP949/EUC-KR CSV 자동 감지, 카드사 원본 파일의 **상단 제목/요약 행 자동 건너뛰기**(`skip_rows`로 수동 지정도 가능), `1,234,567`·`₩12,000`·`12000원` 금액 파싱, `2025.03.08`·`2025년 3월 8일`·`20250308` 날짜 파싱, 한국 공휴일(2023–2027, 대체공휴일 포함) 내장
- **시나리오 라이브러리** — 검증된 시나리오 세트를 JSON 파일로 저장/불러오기 — 매달 같은 기준으로 반복 점검 가능
- **감사 정석 시나리오 대응** — 심야/주말/공휴일 사용, 분할결제, 한도 근접·회피, 상위 백분위 고액(top_percentile), 제한업종, 중복결제, 월별 총액 초과 등
- **보고서 내보내기** — 감사보고서(Markdown) / 이상거래 목록(CSV, 엑셀 호환 BOM)

## 🚀 빠른 시작 (Quick Start)

### 방법 A. npx로 바로 사용 (npm 배포판)

설치 없이 `claude_desktop_config.json`에 아래만 추가하면 됩니다:

```json
{
  "mcpServers": {
    "corpcard-audit": {
      "command": "npx",
      "args": ["-y", "corpcard-audit-mcp-server"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
      }
    }
  }
}
```

### 방법 B. 소스에서 설치

### 1. 설치

```bash
git clone https://github.com/fbaudit/corpcard_audit.git
cd corpcard_audit
npm install
npm run build
```

### 2. Claude Desktop에 연결

`claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "corpcard-audit": {
      "command": "node",
      "args": ["/absolute/path/to/corpcard_audit/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
      }
    }
  }
}
```

> 🔑 **API Key**: AI 시나리오 생성(`corpcard_generate_scenarios`)에 [Anthropic API Key](https://platform.claude.com/)가 필요합니다. 데이터 로드·수동 시나리오·분석·보고서는 키 없이도 동작합니다.

### 3. Claude Code에 연결

```bash
claude mcp add corpcard-audit \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \
  -- node /absolute/path/to/corpcard_audit/dist/index.js
```

### 4. 대화 시작

```
샘플로 sample_data/sample_card_data.csv 불러와서 시나리오 5개 생성해줘
```

## 🛠️ 제공 도구 (Tools)

| Tool | 설명 |
|------|------|
| `corpcard_load_data` | CSV/XLSX 카드내역 로드 + 컬럼 프로파일링 (기존 시나리오가 있으면 자동 재분석) |
| `corpcard_generate_scenarios` | **AI로 시나리오 N개 생성 (1~20) → 즉시 자동 분석** |
| `corpcard_add_scenario` | 룰 DSL로 수동 시나리오 추가 (AI 미사용) |
| `corpcard_list_scenarios` | 등록된 시나리오 목록·룰·최근 결과 조회 |
| `corpcard_run_analysis` | 전체 또는 일부 시나리오 수동 재실행 |
| `corpcard_get_anomalies` | 시나리오별 이상탐지건 상세 (페이지네이션) |
| `corpcard_save_scenarios` | 시나리오 세트를 JSON 라이브러리 파일로 저장 (팀 공유·재사용) |
| `corpcard_load_scenarios` | 저장된 시나리오 라이브러리 불러오기 (데이터가 있으면 즉시 자동 분석) |
| `corpcard_export_report` | 감사보고서(Markdown, **룰 정의 포함 — 감사 증적용**) / 이상거래(CSV) 파일 저장 |

## 📐 룰 DSL

AI가 생성하는(또는 직접 작성하는) 시나리오는 아래 JSON 룰로 표현됩니다.

**행 단위 룰** — 조건에 맞는 개별 거래를 탐지:

```json
{
  "type": "row",
  "logic": "and",
  "conditions": [
    { "field": "사용일시", "operator": "hour_between", "value": [22, 6] },
    { "field": "사용금액", "operator": "gte", "value": 100000 }
  ]
}
```

**집계 룰** — 그룹(카드×가맹점×일자 등) 단위 패턴을 탐지:

```json
{
  "type": "aggregate",
  "group_by": ["카드번호", "가맹점명"],
  "period": "day",
  "date_field": "사용일시",
  "filter": [],
  "having": { "metric": "count", "field": null, "operator": "gte", "value": 3 }
}
```

**연산자**: `eq` `neq` `gt` `gte` `lt` `lte` `contains` `not_contains` `starts_with` `ends_with` `in` `not_in` `regex` `is_empty` `not_empty` `is_weekend` `is_holiday_kr` `hour_between`(자정 넘김 지원) `date_between` `top_percentile`

## 🔒 데이터 프라이버시 — 도입 전 반드시 읽어주세요

기업 도입 시 보안팀 검토에 필요한 정확한 데이터 흐름입니다.

1. **파싱·룰 평가는 전부 로컬**에서 수행됩니다. 전체 거래내역 파일이 이 서버에 의해 외부로 전송되는 일은 없습니다.
2. **AI 시나리오 생성 시** 컬럼 구조, 통계 요약(상위 값 — 이름 컬럼이 있으면 실명 포함 가능), 샘플 8행이 Anthropic API로 전송됩니다. 샘플 행 전송을 원치 않으면 `include_sample_rows: false`(프라이버시 모드)를 사용하세요 — 통계 요약만 전송됩니다.
3. **MCP 클라이언트(Claude Desktop/Code)로 사용하는 것 자체의 영향**: 도구 응답(이상탐지건의 행 데이터 포함)은 대화 컨텍스트에 포함되어 사용 중인 LLM API로 전송됩니다. 이는 이 서버가 아닌 MCP 구조상의 특성이며, 조직의 데이터 정책에 따라 Anthropic 상용 약관(입력 데이터 학습 미사용)·보존 정책 확인 또는 마스킹된 추출본 사용을 권장합니다.
4. 민감 데이터라면 카드번호·사용자명을 마스킹(`5311-****-1101`, `김*준`)한 추출본으로 분석하는 것이 가장 안전합니다.

## ⚙️ 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | AI 시나리오 생성용 API 키 (필수 — 생성 기능 사용 시) | — |
| `CORPCARD_MODEL` | 시나리오 생성 모델 | `claude-opus-4-8` |
| `CORPCARD_EXTRA_HOLIDAYS` | 추가 휴일 (`YYYY-MM-DD,YYYY-MM-DD,...`) — 창립기념일 등 | — |

---

## English

**corpcard-audit-mcp-server** is an MCP (Model Context Protocol) server for corporate-card audit anomaly detection.

**How it works**: load a CSV/XLSX card statement (Korean or English headers, CP949/EUC-KR auto-detected) → Claude generates *N* audit scenarios anchored on the **first column's** value distribution, expressed as an executable rule DSL → a deterministic rule engine evaluates every transaction automatically and returns the anomaly list → export a Markdown audit report or Excel-friendly CSV.

The AI designs the rules; the engine makes the calls — so results are reproducible and audit-evidence-grade. Only the schema, column statistics, and 8 sample rows are sent to the Claude API; the full statement never leaves your machine.

**Setup**: `npm install && npm run build`, then register `dist/index.js` as a stdio MCP server with `ANTHROPIC_API_KEY` in its env (see Quick Start above). Try it with `sample_data/sample_card_data.csv`.

---

## 🧪 개발

```bash
npm run build   # TypeScript 컴파일
npm test        # 룰 엔진·파서 테스트
npm run dev     # tsx로 즉시 실행
```

### npm 배포 (메인테이너용)

```bash
npm login
npm publish     # prepublishOnly가 자동으로 빌드합니다
```

## 🗺️ 로드맵

- [x] 시나리오 라이브러리 저장/불러오기
- [x] 카드사 원본 파일 상단 제목/요약 행 자동 감지
- [ ] 벤포드 법칙(첫 자리 수 분포) 기반 통계 시나리오
- [ ] 동일 시간대·이격 지역 사용 탐지 (가맹점 지역 정보 활용)
- [ ] 여러 파일(월별) 병합 분석
- [ ] 소명요구서 초안 자동 생성

## 🤝 기여

이슈·PR 환영합니다. 실무에서 쓰시는 탐지 시나리오 아이디어를 이슈로 남겨주시면 기본 프롬프트에 반영하겠습니다.

## 📄 License

[MIT](LICENSE)

---

⭐ **이 프로젝트가 감사 업무에 도움이 되었다면 Star 한 번 부탁드립니다!** — *If this saves your audit team some time, a star helps others find it.*
