import { logger } from "../logger";

export type Stage = "started" | "auth" | "dumped" | "uploaded" | "cleaned" | "finished" | "failed";

interface StageStyle {
  title: string;
  color: number;
}

const STAGES: Record<Stage, StageStyle> = {
  started: { title: "🟡 Backup iniciado", color: 0xf1c40f },
  auth: { title: "🔵 Sessão Terabox pronta", color: 0x3498db },
  dumped: { title: "🟢 Dump gerado", color: 0x2ecc71 },
  uploaded: { title: "🟢 Upload concluído", color: 0x2ecc71 },
  cleaned: { title: "🧹 Retenção aplicada", color: 0x9b59b6 },
  finished: { title: "✅ Backup finalizado", color: 0x27ae60 },
  failed: { title: "❌ Backup falhou", color: 0xe74c3c },
};

export interface NotifyField {
  name: string;
  value: string;
  inline?: boolean;
}

export class DiscordNotifier {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  /** A broken webhook must never take the backup down, so failures are logged and swallowed. */
  async notify(stage: Stage, fields: NotifyField[], description?: string): Promise<void> {
    const style = STAGES[stage];

    logger.info(`[${stage}] ${style.title}`, Object.fromEntries(fields.map((field) => [field.name, field.value])));

    if (!this.webhookUrl) {
      return;
    }

    const embed = {
      title: style.title,
      color: style.color,
      description: description ? description.slice(0, 4000) : undefined,
      fields: fields.slice(0, 25).map((field) => ({
        name: field.name.slice(0, 256),
        value: (field.value || "—").slice(0, 1024),
        inline: field.inline ?? true,
      })),
      timestamp: new Date().toISOString(),
      footer: { text: "postgres-dump-to-terabox" },
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Backup", embeds: [embed] }),
      });

      if (!response.ok) {
        logger.warn("Discord webhook returned a non-OK status", {
          status: response.status,
          body: (await response.text()).slice(0, 300),
        });
      }
    } catch (error) {
      logger.warn("Discord webhook request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
