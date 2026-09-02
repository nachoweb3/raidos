import type { BrainDb, MemeSubmissionRow } from "../database/db.js";

/**
 * 😂 MEME ENGINE — contests, submissions, community voting.
 * V1 stores text submissions (caption/meme description, or a media link);
 * image generation and template rendering are V2.
 */

export interface ContestStatus {
  open: boolean;
  reason?: string;
}

export function submissionIsOpen(contest: { status: string } , now = 0): ContestStatus {
  return contest.status === "submissions"
    ? { open: true }
    : { open: false, reason: "Submissions are not open for this contest." };
}

export function votingIsOpen(contest: { status: string }): ContestStatus {
  return contest.status === "voting"
    ? { open: true }
    : { open: false, reason: "Voting is not open for this contest." };
}

export class MemeEngine {
  constructor(
    private db: BrainDb,
    private grantXp: (chatId: number, userId: number, xp: number, reason: string) => void
  ) {}

  openContest(chatId: number, title: string, durationHours?: number): number {
    return this.db.addMemeContest({
      chat_id: chatId,
      title,
      status: "submissions",
      ends_at: durationHours ? Math.floor(Date.now() / 1000) + durationHours * 3600 : null,
    });
  }

  toVoting(contestId: number): boolean {
    const c = this.db.getMemeContest(contestId);
    if (!c || c.status !== "submissions") return false;
    return this.db.setMemeContestStatus(contestId, "voting");
  }

  finishContest(contestId: number): { username: string | null; userId: number | null; votes: number; submissionId: number } | null {
    const c = this.db.getMemeContest(contestId);
    if (!c) return null;
    const winner = this.db.topMemeSubmission(contestId);
    this.db.setMemeContestStatus(contestId, "finished");
    if (!winner) return { username: null, userId: null, votes: 0, submissionId: 0 };
    if (c.xp_reward > 0 && winner.user_id !== null) {
      this.grantXp(c.chat_id, winner.user_id, c.xp_reward, `meme_win:${contestId}`);
    }
    return { username: winner.username, userId: winner.user_id, votes: winner.votes, submissionId: winner.id };
  }

  submit(contestId: number, userId: number, username: string | null, content: string): number | null {
    const c = this.db.getMemeContest(contestId);
    if (!c || c.status !== "submissions") return null;
    return this.db.addMemeSubmission(contestId, userId, username, content);
  }

  vote(contestId: number, userId: number, submissionId: number): "ok" | "not_open" | "not_found" | "own_meme" | "already" {
    const c = this.db.getMemeContest(contestId);
    if (!c || c.status !== "voting") return "not_open";
    const submissions = this.db.listMemeSubmissions(contestId);
    const sub = submissions.find((s) => s.id === submissionId);
    if (!sub || sub.contest_id !== contestId) return "not_found";
    if (sub.user_id === userId) return "own_meme";
    if (this.db.hasVoted(contestId, userId)) return "already";
    this.db.addVote(contestId, userId, submissionId);
    this.grantXp(c.chat_id, userId, 1, "vote");
    return "ok";
  }

  listSubmissions(contestId: number): MemeSubmissionRow[] {
    return this.db.listMemeSubmissions(contestId);
  }
}
