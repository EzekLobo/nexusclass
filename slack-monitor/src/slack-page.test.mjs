import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractUnreadMessages, normalizeAllowedConfig } from "./slack-page.mjs";

test("normalizes the two channel links and mention target", () => {
  const config = normalizeAllowedConfig({ channelUrls: ["https://app.slack.com/client/TABC/C111", "https://app.slack.com/client/TABC/C222"], mentionText: "@Ezekiel Lobo" });
  assert.deepEqual(config.channelUrls, ["https://app.slack.com/client/TABC/C111", "https://app.slack.com/client/TABC/C222"]);
  assert.equal(config.mentionText, "Ezekiel Lobo");
  assert.throws(() => normalizeAllowedConfig({ channelUrls: ["https://app.slack.com/client/TABC/C111", "https://app.slack.com/client/TXYZ/C222"], mentionText: "Ezekiel" }), /mesmo workspace/i);
  assert.throws(() => normalizeAllowedConfig({ channelUrls: ["https://example.com/client/TABC/C111"], mentionText: "Ezekiel" }), /Slack Web/i);
});

test("extracts only unread mention previews in the two selected channels without interacting", async (context) => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { context.skip("Chromium Playwright não instalado neste ambiente."); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-qa="virtual-list-item" data-ts="1763212345678">
        <span data-qa="message_channel_name">#brazil-tutors</span>
        <span data-qa="message_sender_name">Ana</span>
        <div data-qa="message-text">Pode revisar a atividade?</div>
        <span data-stringify-type="user">@Ezekiel Lobo</span>
        <a href="https://app.slack.com/client/TABC/C111/p1763212345678">12:00</a>
        <span>Não lida</span>
      </div>
      <div data-qa="virtual-list-item" data-ts="1763212345679">
        <span data-qa="message_channel_name">#general</span><span data-stringify-type="user">@Ezekiel Lobo</span>
        <div data-qa="message-text">Leia isto</div><a href="https://app.slack.com/client/TABC/C999/p1763212345679">12:01</a>
      </div>
      <div data-qa="virtual-list-item" data-ts="1763212345680">
        <span data-qa="message_channel_name">#brazil-tutors-team-3</span>
        <div data-qa="message-text">O nome @Ezekiel Lobo aparece como texto comum.</div>
        <a href="https://app.slack.com/client/TABC/C222/p1763212345680">12:02</a>
      </div>
    `);
    const unreadText = await page.locator("body").innerText();
    const messages = await extractUnreadMessages(page, { mentionText: "Ezekiel Lobo" });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].channel, "brazil-tutors");
    assert.equal(messages[0].sender, "Ana");
    assert.equal(messages[0].message_id, "1763212345678");
    assert.equal(await page.locator("body").innerText(), unreadText);
    assert.match(await page.locator("body").innerText(), /Não lida/);
  } finally { await browser.close(); }
});
