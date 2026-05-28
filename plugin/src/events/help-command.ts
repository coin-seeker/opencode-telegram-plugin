import type { TelegramBotManager } from "../bot.js";
import type { Logger } from "../lib/logger.js";

export type HelpDispatcher = (ctx: {
  chatId: number;
  userId: number;
  bot: TelegramBotManager;
}) => Promise<void>;

const HELP_TEXT = `<b>OpenCode Telegram Plugin — 명령 도움말</b>

<b>/sessions</b>
활성 root 세션 목록을 번호와 함께 표시 (최근활동순 top 20).

<b>/status &lt;번호&gt;</b>
해당 세션의 에이전트/상태/마지막 메시지 스니펫/플랜 진행도/boulder 상태 표시.

<b>/start_work &lt;번호&gt;</b>
해당 세션에 opencode <code>/start-work</code> 슬래시 커맨드 전송.
안전 게이트: agent='plan' AND status=idle AND .omo/plans 에 미완료 plan 존재 AND .omo/boulder.json 부재.
조건 미충족시 구체적 사유 안내.
(Telegram 봇 명령은 <code>/start_work</code>, 내부 트리거 대상은 opencode 의 <code>/start-work</code>)

<b>/help</b>
이 도움말 표시.

<b>제약</b>
번호는 <code>/sessions</code> 마지막 호출의 스냅샷에 종속 (TTL 1시간).
leader 프로세스가 관찰한 세션만 표시 — 다른 OpenCode 프로세스의 세션은 보이지 않을 수 있음.`;

export function createHelpDispatcher(deps: { logger: Pick<Logger, "info"> }): HelpDispatcher {
  return async ({ chatId, bot }) => {
    await bot.sendMessage(HELP_TEXT, { parse_mode: "HTML" });
    deps.logger.info("help shown", { chatId });
  };
}
