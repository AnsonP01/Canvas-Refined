/**
 * background.js — service worker (Chrome) / event page (Firefox).
 * Only job: wake up exactly when the dark-mode schedule flips and tell open
 * Canvas tabs to re-check. No polling; the worker sleeps the rest of the time.
 */
// Chrome runs this as a service worker and loads shared.js here. Firefox runs it as an
// event page, where the manifest's background.scripts has already loaded shared.js.
if (typeof importScripts === 'function') importScripts('shared.js');

const ALARM = 'mc-schedule';

/** (Re)create the single alarm for the next schedule boundary, if needed. */
async function reschedule() {
  const s = await MC.load();
  await chrome.alarms.clear(ALARM);
  if (s.dark.enabled && s.dark.mode === 'schedule') {
    chrome.alarms.create(ALARM, { when: MC.nextBoundary(s.dark).getTime() + 500 });
  }
}

async function pingTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.instructure.com/*' });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'mc-tick' }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(reschedule);
chrome.runtime.onStartup.addListener(reschedule);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) reschedule();
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  await pingTabs();
  await reschedule();
});
