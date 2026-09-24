const EPIC_API =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowPromoted=true";

const SUBSCRIBER_PREFIX = "sub:";

const CALLBACK = {
  CURRENT: "games:current",
  UPCOMING: "games:upcoming",
};

function getOfferGroups(promotions, kind) {
  const groups =
    kind === "current" ? promotions?.promotionalOffers : 
    promotions?.upcomingPromotionalOffers;

  return (groups ?? []).flatMap((group) => group.promotionalOffers ?? []);
}

function isFreeOffer(offer) {
  return offer.discountSetting?.discountPercentage === 0;
}

function isActiveOffer(offer, now) {
  const start = new Date(offer.startDate);
  const end = new Date(offer.endDate);
  return now >= start && now <= end;
}

function getGameUrl(game) {
  const pageSlug = game.offerMappings?.find(
    (mapping) => mapping.pageType === "productHome"
  )?.pageSlug;

  if (pageSlug) {
    return `https://store.epicgames.com/en-US/p/${pageSlug}`;
  }

  if (game.productSlug) {
    return `https://store.epicgames.com/en-US/p/${game.productSlug}`;
  }

  return "https://store.epicgames.com/en-US/free-games";
}

function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function parseFreeGames(data, now = new Date()) {
  const elements = data?.data?.Catalog?.searchStore?.elements ?? [];
  const current = [];
  const upcoming = [];

  for (const game of elements) {
    const currentOffers = getOfferGroups(game.promotions, "current").filter(
      isFreeOffer
    );
    const upcomingOffers = getOfferGroups(game.promotions, "upcoming").filter(
      isFreeOffer
    );

    const activeOffer = currentOffers.find((offer) => isActiveOffer(offer, now));
    if (activeOffer) {
      current.push({
        id: `${game.id}:${activeOffer.startDate}`,
        title: game.title,
        url: getGameUrl(game),
        startDate: activeOffer.startDate,
        endDate: activeOffer.endDate,
      });
      continue;
    }

    const nextOffer = upcomingOffers[0];
    if (nextOffer) {
      upcoming.push({
        id: `${game.id}:${nextOffer.startDate}`,
        title: game.title,
        url: getGameUrl(game),
        startDate: nextOffer.startDate,
        endDate: nextOffer.endDate,
      });
    }
  }

  return { current, upcoming };
}

function formatGameList(games, kind) {
  if (games.length === 0) {
    return kind === "current"
      ? "No free games found right now."
      : "No free games scheduled for next week yet.";
  }

  return games
    .map((game) => {
      if (kind === "current") {
        return [`• ${game.title}`, `  until ${formatDate(game.endDate)}`, `  ${game.url}`].join(
          "\n"
        );
      }

      return [
        `• ${game.title}`,
        `  from ${formatDate(game.startDate)} to ${formatDate(game.endDate)}`,
        `  ${game.url}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildCurrentMessage(games) {
  return ["🎁 Free now on Epic Games", "", formatGameList(games.current, "current")].join(
    "\n"
  );
}

function buildUpcomingMessage(games) {
  return [
    "📅 Free games next week",
    "",
    formatGameList(games.upcoming, "upcoming"),
  ].join("\n");
}

function buildMessage(games) {
  const lines = ["🎮 Epic Games free games", ""];

  if (games.current.length > 0) {
    lines.push("Free now:", formatGameList(games.current, "current"), "");
  } else {
    lines.push("No free games found right now.", "");
  }

  if (games.upcoming.length > 0) {
    lines.push("Coming soon for free:", formatGameList(games.upcoming, "upcoming"));
  }

  return lines.join("\n").trim();
}

function getGamesKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🎁 Free now", callback_data: CALLBACK.CURRENT },
        { text: "📅 Next week", callback_data: CALLBACK.UPCOMING },
      ],
    ],
  };
}

function requireKv(env) {
  if (!env.GAMES_KV) {
    throw new Error(
      "KV required: wrangler kv namespace create GAMES_KV, then set the id in wrangler.toml"
    );
  }
}

async function addSubscriber(env, chatId) {
  requireKv(env);
  await env.GAMES_KV.put(`${SUBSCRIBER_PREFIX}${chatId}`, new Date().toISOString());
}

async function removeSubscriber(env, chatId) {
  if (!env.GAMES_KV) {
    return;
  }

  await env.GAMES_KV.delete(`${SUBSCRIBER_PREFIX}${chatId}`);
}

async function getSubscribers(env) {
  requireKv(env);

  const subscribers = [];
  let cursor;

  do {
    const page = await env.GAMES_KV.list({ prefix: SUBSCRIBER_PREFIX, cursor });
    for (const key of page.keys) {
      subscribers.push(key.name.slice(SUBSCRIBER_PREFIX.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return subscribers;
}

async function telegramRequest(env, method, body) {
  const botToken = String(env.BOT_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("Set the BOT_TOKEN secret via wrangler secret put");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  if (!result.ok) {
    const error = new Error(`Telegram API error: ${result.description ?? response.status}`);
    error.telegram = result;
    throw error;
  }

  return result;
}

async function sendTelegramMessage(env, text, options = {}) {
  const chatId = options.chatId;
  if (!chatId) {
    throw new Error("chatId is required");
  }

  try {
    return await telegramRequest(env, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (error.telegram?.error_code === 403) {
      await removeSubscriber(env, chatId);
    }
    throw error;
  }
}

async function broadcastMessage(env, text, replyMarkup) {
  const subscribers = await getSubscribers(env);
  let sent = 0;
  let failed = 0;

  for (const chatId of subscribers) {
    try {
      await sendTelegramMessage(env, text, { chatId, replyMarkup });
      sent++;
    } catch {
      failed++;
    }
  }

  return { sent, failed, total: subscribers.length };
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  return telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function fetchFreeGames() {
  const epicResponse = await fetch(EPIC_API, {
    headers: {
      Accept: "application/json",
      "User-Agent": "EpicFreeGamesBot/1.0",
    },
  });

  if (!epicResponse.ok) {
    throw new Error(`Epic API error: ${epicResponse.status}`);
  }

  const epicData = await epicResponse.json();
  return parseFreeGames(epicData);
}

async function sendGamesByType(env, chatId, type) {
  const games = await fetchFreeGames();
  const text =
    type === CALLBACK.CURRENT ? buildCurrentMessage(games) : buildUpcomingMessage(games);

  await sendTelegramMessage(env, text, {
    chatId,
    replyMarkup: getGamesKeyboard(),
  });
}

async function handleCallbackQuery(env, query) {
  const chatId = query.message?.chat?.id ?? query.from?.id;
  const { id, data } = query;

  if (!chatId) {
    throw new Error("Could not determine chat id");
  }

  if (data !== CALLBACK.CURRENT && data !== CALLBACK.UPCOMING) {
    await answerCallbackQuery(env, id, "Unknown button").catch(() => {});
    return;
  }

  await sendGamesByType(env, chatId, data);
  await answerCallbackQuery(env, id, "Done!").catch(() => {});
}

async function handleTelegramUpdate(env, update) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.text) {
      return;
    }

    const chatId = message.chat.id;
    const command = message.text.split(/\s+/)[0].toLowerCase();

    if (command === "/start" || command === "/menu") {
      await addSubscriber(env, chatId);
      await sendTelegramMessage(
        env,
        "Hi! You're subscribed to Epic Games free game alerts.\n\nI'll send a new list every week. Use the buttons below to check current free games anytime.\n\nTo unsubscribe: /stop",
        { chatId, replyMarkup: getGamesKeyboard() }
      );
      return;
    }

    if (command === "/stop") {
      await removeSubscriber(env, chatId);
      await sendTelegramMessage(
        env,
        "You've been unsubscribed from weekly alerts. To subscribe again, send /start",
        { chatId }
      );
      return;
    }

    if (command === "/current") {
      await sendGamesByType(env, chatId, CALLBACK.CURRENT);
      return;
    }

    if (command === "/upcoming") {
      await sendGamesByType(env, chatId, CALLBACK.UPCOMING);
    }
  } catch (error) {
    console.error("Telegram update error:", error);

    const chatId =
      update.callback_query?.message?.chat?.id ??
      update.callback_query?.from?.id ??
      update.message?.chat?.id;

    if (chatId) {
      await sendTelegramMessage(
        env,
        `⚠️ Error: ${error.message}`,
        { chatId, replyMarkup: getGamesKeyboard() }
      ).catch(() => {});
    }

    if (update.callback_query?.id) {
      await answerCallbackQuery(
        env,
        update.callback_query.id,
        "An error occurred"
      ).catch(() => {});
    }

    throw error;
  }
}

async function notifyFreeGames(env) {
  const games = await fetchFreeGames();
  const message = buildMessage(games);

  const signature = [...games.current, ...games.upcoming]
    .map((game) => game.id)
    .sort()
    .join("|");

  if (env.GAMES_KV && signature) {
    const lastSignature = await env.GAMES_KV.get("lastSignature");
    if (lastSignature === signature) {
      return { skipped: true, games, message };
    }
  }

  const delivery = await broadcastMessage(env, message, getGamesKeyboard());

  if (delivery.total === 0) {
    return { skipped: true, games, message, reason: "no_subscribers" };
  }

  if (env.GAMES_KV && signature) {
    await env.GAMES_KV.put("lastSignature", signature);
  }

  return { skipped: false, games, message, delivery };
}

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function getWebhookSecret(env) {
  const secret = String(env.WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    return null;
  }

  if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
    throw new Error(
      "WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _, and -. Update with: wrangler secret put WEBHOOK_SECRET"
    );
  }

  return secret;
}

async function setTelegramWebhook(env, webhookUrl) {
  const body = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
  };
  const webhookSecret = getWebhookSecret(env);

  if (webhookSecret) {
    body.secret_token = webhookSecret;
  }

  return telegramRequest(env, "setWebhook", body);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        if (env.WEBHOOK_SECRET) {
          const expectedSecret = getWebhookSecret(env);
          const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")?.trim();
          if (secret !== expectedSecret) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }

      const update = await request.json();
      ctx.waitUntil(
        handleTelegramUpdate(env, update).catch((error) => {
          console.error("Webhook handler failed:", error);
        })
      );

      return new Response("ok");
    }

    if (url.pathname === "/check-bot" && request.method === "GET") {
      const secret = url.searchParams.get("secret")?.trim();
      if (!env.RUN_SECRET || secret !== String(env.RUN_SECRET).trim()) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await telegramRequest(env, "getMe", {});
        return Response.json({ ok: true, bot: result.result });
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error.message,
            hint: "Update BOT_TOKEN: wrangler secret put BOT_TOKEN",
          },
          { status: 400 }
        );
      }
    }

    if (url.pathname === "/set-webhook" && request.method === "GET") {
      const secret = url.searchParams.get("secret")?.trim();
      if (!env.RUN_SECRET || secret !== String(env.RUN_SECRET).trim()) {
        return new Response("Unauthorized", { status: 401 });
      }

      const webhookUrl = `${url.origin}/webhook`;

      try {
        const result = await setTelegramWebhook(env, webhookUrl);
        return Response.json({ ok: true, webhookUrl, result });
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error.message,
            hint: "First check /check-bot?secret=... — BOT_TOKEN is likely invalid",
          },
          { status: 400 }
        );
      }
    }

    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret")?.trim();
      if (!env.RUN_SECRET || secret !== String(env.RUN_SECRET).trim()) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await notifyFreeGames(env);
      return Response.json(result);
    }

    return new Response(
      "Epic Games bot is running. Endpoints: /health, /webhook, /set-webhook?secret=..., /run?secret=...",
      { status: 404 }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyFreeGames(env));
  },
};
