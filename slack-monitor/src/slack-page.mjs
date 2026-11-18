const allowedChannels = new Set(["brazil-tutors", "brazil-tutors-team-3"]);

export function normalizeAllowedConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const channelUrls = Array.isArray(input.channelUrls) ? input.channelUrls.slice(0, 2).map((item) => String(item).trim()) : [];
  for (const value of channelUrls) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)slack\.com$/i.test(url.hostname) || !url.pathname.includes("/client/")) throw new Error("Use links de canais copiados do Slack Web.");
  }
  if (channelUrls.length === 2) {
    const workspaces = channelUrls.map((value) => new URL(value).pathname.split("/").filter(Boolean)[1]);
    if (!workspaces[0] || workspaces[0] !== workspaces[1]) throw new Error("Os dois canais precisam pertencer ao mesmo workspace do Slack.");
  }
  const mentionText = typeof input.mentionText === "string" ? input.mentionText.trim().replace(/^@/, "").slice(0, 100) : "";
  const apiBase = typeof input.apiBase === "string" ? input.apiBase.trim() : "";
  return { channelUrls, mentionText, apiBase };
}

export async function isLoginRequired(page) {
  const url = page.url();
  if (/\/signin|\/login|accounts\.slack\.com/i.test(url)) return true;
  const visibleLogin = await page.getByRole("button", { name: /sign in|entrar|continuar com/i }).first().isVisible().catch(() => false);
  return visibleLogin;
}

export async function extractUnreadMessages(page, config) {
  if (await isLoginRequired(page)) return [];
  const ready = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (!ready) throw new Error("A tela de mensagens não carregou.");
  const collectVisible = async () => page.evaluate(({ targetMention, allowed }) => {
    const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
    const unique = new Map();
    const containers = [...document.querySelectorAll('[data-qa="virtual-list-item"], [data-qa="unread_item"], [data-qa="message_container"]')];
    for (const element of containers) {
      const text = (element.innerText || "").trim();
      if (!text || text.length > 10_000) continue;
      const channelNode = element.querySelector('[data-qa*="channel_name"], [data-qa="message_channel_name"], a[href*="/archives/"]');
      const channelText = channelNode?.textContent?.trim().replace(/^#/, "") || "";
      const channel = allowed.find((name) => normalize(channelText) === normalize(name) || normalize(text).includes(`#${normalize(name)}`));
      if (!channel) continue;
      const mentions = [...element.querySelectorAll('[data-stringify-type="user"], [data-qa*="mention"], [data-qa*="user_mention"]')];
      if (!mentions.some((mention) => normalize(mention.textContent).replace(/^@/, "") === normalize(targetMention))) continue;
      const messageNode = element.querySelector('[data-qa="message-text"], [data-qa="message_content"], [data-qa="message_container"]') || element;
      const messageText = (messageNode.innerText || text).trim();
      const anchors = [...element.querySelectorAll('a[href]')];
      const permalink = anchors.find((anchor) => /\/archives\/|\/client\/[^/]+\/[^/]+\/p\d{10,}/.test(anchor.getAttribute("href") || ""));
      const href = permalink?.href || "";
      const idFromData = element.getAttribute("data-ts") || element.getAttribute("data-message-id") || element.getAttribute("data-item-key") || messageNode.getAttribute("data-ts");
      const timestampFromUrl = href.match(/p(\d{10,})/)?.[1];
      const id = idFromData || timestampFromUrl;
      const sender = element.querySelector('[data-qa="message_sender_name"], [data-qa="message_sender"]')?.textContent?.trim() || "Slack";
      if (!id || !href) continue;
      const timestamp = element.querySelector("time")?.getAttribute("datetime") || new Date(Number(timestampFromUrl || 0) / 1_000_000).toISOString();
      const key = `${channel}:${id}`;
      unique.set(key, { message_id: String(id), channel, sender: sender.slice(0, 160), text: messageText.slice(0, 6000), url: href.slice(0, 2000), timestamp });
    }
    return [...unique.values()];
  }, { targetMention: config.mentionText, allowed: [...allowedChannels] });
  const messages = new Map();
  for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
    for (const message of await collectVisible()) messages.set(`${message.channel}:${message.message_id}`, message);
    const advanced = await page.evaluate(() => {
      const firstMessage = document.querySelector('[data-qa="virtual-list-item"], [data-qa="unread_item"], [data-qa="message_container"]');
      let current = firstMessage;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (current.scrollHeight > current.clientHeight + 80 && /(auto|scroll)/.test(style.overflowY)) {
          const previous = current.scrollTop;
          current.scrollTop = Math.min(current.scrollTop + Math.max(current.clientHeight * 0.8, 400), current.scrollHeight);
          return current.scrollTop > previous;
        }
        current = current.parentElement;
      }
      return false;
    });
    if (!advanced) break;
    await page.waitForTimeout(180);
  }
  return [...messages.values()];
}
