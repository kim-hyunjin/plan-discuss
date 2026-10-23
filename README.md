# plan-discuss

Plan mode에서 계획서가 작성된 뒤, 승인 전에 계획서에 대해 질문하고 토론하는 단계를 넣어주는 mod.

## 흐름

1. plan 모드에서 모델이 계획서를 쓰고 `ExitPlanMode`를 호출한다.
2. mod가 그 첫 호출을 가로채 **토론 모드**로 들어간다. 모델은 계획서가 준비됐다고 알리고, 대화창에 계획서 내용을 보여준 뒤 턴을 끝낸다 (`showPlan` 설정: 전문 · 요약 · 끄기). `/plan-talk`로 직접 들어갈 때도 계획서 파일 내용이 출력된다.
3. 토론 모드에서 하는 말은 전부 *질문/검토*로 처리된다. 계획서 수정(Write/Edit)과 ExitPlanMode는 차단된다.
4. 수정이 필요하면 `/plan-edit <지시>` 로 한 번 수정하고 자동으로 토론 모드로 복귀한다. `/plan-edit`만 치면 수정 모드에 머문다.
5. `/plan-go [추가 지시]` 로 승인한다. 모델이 ExitPlanMode를 호출하면 승인 다이얼로그 대신 mod가 바로 허용하고 권한 모드를 `auto`로 바꿔 구현을 시작한다.

## 명령

| 명령 | 역할 |
| --- | --- |
| `/plan-talk` | 토론 모드 (질문만, 계획서 수정 없음) |
| `/plan-edit [지시]` | 수정 모드. 지시가 있으면 한 번 수정 후 토론 모드 복귀 |
| `/plan-go [지시]` | 승인 → ExitPlanMode → auto 모드로 구현 시작 |
| `/plan-model [discuss\|edit] <모델\|off>` | 토론/수정 단계에서 쓸 모델을 이 세션에서 지정. 인자 없이 치면 현재 설정을 보여줌 |

프롬프트 위 밴드의 버튼으로도 같은 일을 할 수 있다 (t / e / g 핫키).

## 설정 (`/config`)

- **승인 후 권한 모드** (`approveMode`): `auto`(기본) · `acceptEdits` · `default` · `bypassPermissions` · `dialog`(기본 승인 다이얼로그 유지)
- **첫 ExitPlanMode를 토론 모드로 가로채기** (`interceptExit`): 끄면 `/plan-talk`를 직접 쳐야 토론 모드가 된다.
- **토론 단계 모델** (`discussModel`) · **수정 단계 모델** (`editModel`): 각 단계에 들어갈 때 `/model <이름>`으로 전환하고, 단계를 벗어나면(승인·plan 모드 종료) 원래 모델로 되돌린다. 비우면 전환하지 않는다. `/plan-model`로 세션 안에서 덮어쓸 수 있다.
- **토론 모드 진입 시 계획서 표시** (`showPlan`): `full`(기본, 계획서 전문) · `summary`(목표·접근과 근거·단계·열린 질문 요약) · `off`

## 설치

터미널 세션의 프롬프트에서:

```
/plugin install plan-discuss --marketplace kim-hyunjin/plan-discuss
```

`y`로 마켓플레이스를 추가하고, 범위(user 권장)를 고르면 바로 활성화된다.

셸에서:

```
claude plugin install plan-discuss --marketplace kim-hyunjin/plan-discuss
```

데스크톱 앱에서는 프롬프트 옆 + → Plugins → Add marketplace에 `kim-hyunjin/plan-discuss` → Add plugin.
