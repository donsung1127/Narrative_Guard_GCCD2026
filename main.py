import json
import re
import os
from typing import List, Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv

# 1. .env 파일 로드
load_dotenv()

app = FastAPI(title="Part C Narrative Guard Server")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------
# 변환 프록시 URL 및 API 키 설정 (Dramamancer 및 .env 규격 맞춤)
# ------------------------------------------------------------
# ANTHROPIC_BASE_URL 또는 ANTHROPIC_API_URL 중 어떤 것이 들어와도 /v1/messages 경로 자동 조립
base_url = os.getenv("ANTHROPIC_BASE_URL") or os.getenv("ANTHROPIC_API_URL") or "https://api.anthropic.com"
base_url = base_url.rstrip("/")

if not base_url.endswith("/v1/messages"):
    ANTHROPIC_API_URL = f"{base_url}/v1/messages"
else:
    ANTHROPIC_API_URL = base_url

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# ------------------------------------------------------------
# 요청 / 응답 데이터 규격
# ------------------------------------------------------------

class NPCInfo(BaseModel):
    name: str
    persona: str
    emotion: str

class NarrativeRequest(BaseModel):
    player_action: str
    location: str
    action_result: str  # "SUCCESS", "FAIL", "PARTIAL"
    reason: str
    npc_info: NPCInfo
    recent_history: List[str]

class NarrativeResponse(BaseModel):
    speaker: str
    dialogue: str
    narration: str
    is_fallback: bool = False

# ------------------------------------------------------------
# 프롬프트 및 가드레일 로직
# ------------------------------------------------------------

SYSTEM_PROMPT = """너는 내러티브 게임의 스토리텔러이자 NPC 대사 생성기이다.
너의 역할은 [시스템 확정 결과]를 기반으로, 상황에 맞는 NPC 대사와 플레이어에게 보여줄 상황 서술을 생성하는 것이다.

[엄격한 생성 규칙]
1. [시스템 확정 결과]에 절대적으로 복종해야 한다.
2. 행동 결과가 '실패(FAIL)'이면 플레이어가 시도에 실패했음이 대사와 서술에 명확히 드러나야 한다.
3. 시스템 결과에서 허용되지 않은 아이템 획득, 장소 이동, 전투 승리, 비밀 밝혀짐 등의 내용을 절대로 묘사하지 마라. (환각 금지)
4. NPC의 캐릭터 페르소나, 말투, 현재 감정 상태를 충실히 반영하여 대사를 작성하라.
5. 출력 형식은 반드시 지정된 JSON 구조를 준수해야 하며, 추가적인 설명이나 인사말은 포함하지 마라."""

USER_PROMPT_TEMPLATE = """[NPC 정보]
이름: {name}
성격 및 배경: {persona}
현재 감정 상태: {emotion}

[현재 상황]
장소: {location}

[최근 대화 및 행동 기록]
{recent_history}

[시스템 확정 결과 (파트 B 제공)]
플레이어 시도 행동: {player_action}
최종 결과: {action_result} (SUCCESS / FAIL / PARTIAL)
상세 사유: {result_reason}

[지시 사항]
위 [시스템 확정 결과]를 바탕으로 NPC의 반응 대사와 상황 서술을 작성하라.
결과가 'FAIL'인 경우, NPC가 시도를 제지하거나 거절하는 반응을 보여야 한다.

[출력 포맷 (JSON)]
{{
  "speaker": "{name}",
  "dialogue": "NPC의 대사 (말투 및 감정 반영)",
  "narration": "플레이어 행동 결과 및 NPC 반응에 대한 3인칭 상황 서술"
}}"""

FAIL_FORBIDDEN_KEYWORDS = [
    "건넸다", "손에 쥐어", "주머니에 넣", "성공", "획득", 
    "열렸다", "이동했다", "알려주었다", "비밀을 말"
]

def validate_guardrail(raw_text: str, expected_speaker: str, action_result: str) -> tuple[bool, Optional[dict], str]:
    cleaned_text = re.sub(r'```(?:json)?\s*|\s*```', '', raw_text).strip()
    
    try:
        parsed = json.loads(cleaned_text)
    except json.JSONDecodeError:
        return False, None, "Format Error: JSON 파싱 실패"

    if not all(k in parsed for k in ["speaker", "dialogue", "narration"]):
        return False, None, "Format Error: 필수 키 누락"
    if parsed["speaker"] != expected_speaker:
        return False, None, f"Speaker Mismatch: {parsed['speaker']} != {expected_speaker}"

    full_text = f"{parsed['dialogue']} {parsed['narration']}"
    if action_result == "FAIL":
        for kw in FAIL_FORBIDDEN_KEYWORDS:
            if kw in full_text:
                return False, None, f"Hallucination Detected: FAIL 상태에서 금지어 '{kw}'가 사용됨"

    return True, parsed, "OK"

def get_fallback_narrative(req: NarrativeRequest) -> NarrativeResponse:
    return NarrativeResponse(
        speaker=req.npc_info.name,
        dialogue=f"... (차가운 눈빛으로) {req.reason}",
        narration=f"{req.npc_info.name}은(는) 요구를 거절하며 플레이어를 제지한다.",
        is_fallback=True
    )

# ------------------------------------------------------------
# API 엔드포인트
# ------------------------------------------------------------

@app.get("/")
async def root():
    return {"status": "ok", "message": "Part C Narrative Guard Server is running"}

@app.post("/generate-narrative", response_model=NarrativeResponse)
async def generate_narrative(req: NarrativeRequest):
    if not ANTHROPIC_API_KEY:
        print("[오류] ANTHROPIC_API_KEY가 로드되지 않았습니다. .env 파일을 확인해주세요.")
        return get_fallback_narrative(req)

    history_str = "\n".join(req.recent_history)
    user_prompt = USER_PROMPT_TEMPLATE.format(
        name=req.npc_info.name,
        persona=req.npc_info.persona,
        emotion=req.npc_info.emotion,
        location=req.location,
        recent_history=history_str,
        player_action=req.player_action,
        action_result=req.action_result,
        result_reason=req.reason
    )

    # utils.ts 규격과 완벽 통일: x-api-key 사용, Authorization 제거
    headers = {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
    }

    # utils.ts 규격과 동일하게 기본 모델을 'claude-sonnet-5'로 설정
    payload = {
        "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
        "messages": [
            {"role": "user", "content": user_prompt}
        ],
        "system": SYSTEM_PROMPT,
        "max_tokens": 1000
    }

    print(f"[API 요청 시도] URL: {ANTHROPIC_API_URL}")

    try:
        async with httpx.AsyncClient() as httpx_client:
            res = await httpx_client.post(ANTHROPIC_API_URL, headers=headers, json=payload, timeout=30.0)
            
            if res.status_code != 200:
                print(f"[API 오류] HTTP {res.status_code}: {res.text}")
                return get_fallback_narrative(req)

            data = res.json()
            
            # utils.ts 응답 처리 로직 적용 (thinking 토큰 건너뛰기)
            content_item = data["content"][0] if data["content"][0].get("type") == "text" else data["content"][1]
            raw_response = content_item["text"]

    except Exception as e:
        print(f"[API 오류] 호출 중 예외 발생: {e}")
        return get_fallback_narrative(req)

    # 가드레일 검증
    is_valid, parsed_data, err_msg = validate_guardrail(raw_response, req.npc_info.name, req.action_result)
    
    if not is_valid:
        print(f"[Guardrail 차단] 사유: {err_msg}")
        return get_fallback_narrative(req)

    return NarrativeResponse(
        speaker=parsed_data["speaker"],
        dialogue=parsed_data["dialogue"],
        narration=parsed_data["narration"],
        is_fallback=False
    )