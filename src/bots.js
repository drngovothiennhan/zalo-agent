// Several Zalo bots served by one Worker.
// Shared by all bots: AI providers, system prompt, medical safety rules, knowledge base/templates, family notes.
// Per bot: display name, optional persona line, token, webhook secret, webhook path, allowed Zalo IDs, reminders.
//
// To add a bot: add an entry here, then in Cloudflare add its secrets/vars (names below),
// deploy, and open /setup?key=<WEBHOOK_SECRET>&bot=<id> once to register its webhook.
export const BOTS = {
  main: {
    id: "main",
    name: "Bot Dr Tâm Phúc",
    path: "/webhook",
    tokenVar: "BOT_TOKEN",
    secretVar: "WEBHOOK_SECRET",
    allowedVar: "ALLOWED_IDS",
    personaVar: "BOT_PERSONA",
  },
  binbo: {
    id: "binbo",
    name: "Bot Bin Bơ",
    path: "/webhook/binbo",
    tokenVar: "BOT_TOKEN_BINBO",
    secretVar: "WEBHOOK_SECRET_BINBO",
    allowedVar: "ALLOWED_IDS_BINBO",
    personaVar: "BOT_PERSONA_BINBO",
  },
};

export const botById = (id) => BOTS[id] || BOTS.main;
export const botByPath = (path) => Object.values(BOTS).find((b) => b.path === path) || null;

// The Worker env as seen by one bot: same bindings and shared settings, that bot's token/name/allowed list.
// WEBHOOK_SECRET is NOT overridden: it stays the owner's admin key for /kb, /setup and /debug.
export function botEnv(env, bot) {
  return {
    ...env,
    BOT_ID: bot.id,
    BOT_TOKEN: env[bot.tokenVar],
    BOT_NAME: (bot.id === "main" && env.BOT_NAME) || bot.name,
    BOT_PERSONA: env[bot.personaVar] || "",
    ALLOWED_IDS: env[bot.allowedVar] || env.ALLOWED_IDS || env.OWNER_ID || "",
  };
}
