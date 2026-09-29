import { ajax } from '../src/ajax.js';
import {
  generateUUID,
  logInfo,
  logError,
  logWarn,
  getWindowSelf,
  getWinDimensions,
  getPerformanceNow,
  isEmptyStr,
} from '../src/utils.js';
import { getGlobal } from '../src/prebidGlobal.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import { EVENTS } from '../src/constants.js';
import adapterManager, { gdprDataHandler } from '../src/adapterManager.js';
import { getRefererInfo } from '../src/refererDetection.js';
import { config } from '../src/config.js';
import { getViewportSize } from '../libraries/viewport/viewport.js';

const GVLID = 1122;
const ModuleCode = 'agma';
const analyticsType = 'endpoint';
const scriptVersion = '1.10.0';
const batchDelayInMs = 1000;
const agmaURL = 'https://pbc.agma-analytics.de/v1';
const pageViewId = generateUUID();

const getUserIDs = () => {
  try {
    return getGlobal().getUserIdsAsEids();
  } catch (e) {}
  return [];
};

export const getOrtb2Data = (options = {}) => {
  try {
    const ortb2 = config.getAnyConfig('ortb2') || {};
    const win = getWindowSelf();
    return {
      site: win.agma?.ortb2?.site ?? options.ortb2?.site ?? ortb2.site,
      user: win.agma?.ortb2?.user ?? options.ortb2?.user ?? ortb2.user,
    };
  } catch (e) {
    return {};
  }
};

export const getTiming = () => {
  const elapsedTime = getPerformanceNow();
  let ttfb = 0;
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    ttfb = Math.round(entry.responseStart - entry.startTime);
  } catch (e) {}
  return {
    ttfb: ttfb >= 0 && ttfb <= elapsedTime ? ttfb : 0,
    elapsedTime,
  };
};

export const getPayload = (auctionIds, options) => {
  if (!options || !auctionIds || auctionIds.length === 0) {
    return false;
  }
  const consentData = gdprDataHandler.getConsentData();
  let gdprApplies = true; // we assume gdpr applies
  let useExtendedPayload = false;
  if (consentData) {
    gdprApplies = consentData.gdprApplies;
    const consents = consentData.vendorData?.vendor?.consents || {};
    useExtendedPayload = consents[GVLID];
  }
  const ortb2 = getOrtb2Data(options);
  const ri = getRefererInfo() || {};

  let payload = {
    auctionIds: auctionIds,
    pageViewId,
    domain: ri.domain,
    gdprApplies,
    code: options.code,
    ortb2: { site: ortb2.site },
    pageUrl: ri.page,
    prebidVersion: '$prebid.version$',
    scriptVersion,
    timing: getTiming(),
  };

  if (useExtendedPayload) {
    const device = config.getConfig('device') || {};
    const { width = 0, height = 0 } = getViewportSize();
    const { screen } = getWinDimensions();
    const userIdsAsEids = getUserIDs();
    payload = {
      ...payload,
      ortb2,
      extended: true,
      timestamp: Date.now(),
      gdprConsentString: consentData.consentString,
      timezoneOffset: new Date().getTimezoneOffset(),
      language: window.navigator.language,
      referrer: ri.topmostLocation,
      pageUrl: ri.page,
      screenWidth: width,
      screenHeight: height,
      deviceWidth: device.w || screen.width,
      deviceHeight: device.h || screen.height,
      userIdsAsEids,
    };
  }
  return payload;
};

const agmaAnalytics = Object.assign(adapter({ analyticsType }), {
  auctionIds: [],
  started: new Set(),
  timer: null,
  track({ eventType, args }) {
    const auctionId = args?.auctionId;
    if (!auctionId) {
      return;
    }
    if (eventType === EVENTS.AUCTION_INIT) {
      this.started.add(auctionId);
      this.queueAuction(auctionId);
    } else if (eventType === EVENTS.AUCTION_END) {
      const alreadyCounted = this.started.delete(auctionId);
      if (!alreadyCounted) {
        this.queueAuction(auctionId);
      }
    }
  },
  queueAuction(auctionId) {
    this.auctionIds.push(auctionId);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.processBatch();
      }, batchDelayInMs);
    }
  },
  processBatch() {
    const auctionIds = this.auctionIds;
    this.auctionIds = [];
    clearTimeout(this.timer);
    this.timer = null;
    this.send(getPayload(auctionIds, this.options));
  },
  send(payload) {
    if (!payload) {
      return;
    }
    return ajax(
      agmaURL,
      () => {
        logInfo(ModuleCode, 'flushed', payload);
      },
      JSON.stringify(payload),
      {
        contentType: 'text/plain',
        method: 'POST',
        keepalive: true,
      }
    );
  },
});

const flushOnHide = (event) => {
  if (event.type === 'pagehide' || document.visibilityState === 'hidden') {
    agmaAnalytics.processBatch();
  }
};

agmaAnalytics.originEnableAnalytics = agmaAnalytics.enableAnalytics;
agmaAnalytics.enableAnalytics = function (config = {}) {
  const options = { ...config.options };

  if (options.site && !options.code) {
    logWarn(ModuleCode, 'options.site is deprecated, use options.code');
    options.code = options.site;
  }

  if (!options.code || isEmptyStr(options.code)) {
    logError(ModuleCode, 'options.code missing, analytics disabled');
    return false;
  }

  if (options.triggerEvent) {
    logWarn(ModuleCode, 'options.triggerEvent is ignored');
  }
  if (options.sampling !== undefined) {
    logWarn(ModuleCode, 'options.sampling is ignored');
  }
  agmaAnalytics.options = options;

  agmaAnalytics.originEnableAnalytics({
    ...config,
    options: { ...options, sampling: 1 },
    includeEvents: [EVENTS.AUCTION_INIT, EVENTS.AUCTION_END],
    excludeEvents: [],
  });
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', flushOnHide);
};

agmaAnalytics.originDisableAnalytics = agmaAnalytics.disableAnalytics;
agmaAnalytics.disableAnalytics = function () {
  document.removeEventListener('visibilitychange', flushOnHide);
  window.removeEventListener('pagehide', flushOnHide);
  clearTimeout(agmaAnalytics.timer);
  agmaAnalytics.timer = null;
  agmaAnalytics.auctionIds = [];
  agmaAnalytics.started.clear();
  agmaAnalytics.originDisableAnalytics();
};

adapterManager.registerAnalyticsAdapter({
  adapter: agmaAnalytics,
  code: ModuleCode,
  gvlid: GVLID,
});

export default agmaAnalytics;
