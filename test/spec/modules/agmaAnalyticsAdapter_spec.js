import adapterManager, { gdprDataHandler } from '../../../src/adapterManager.js';
import agmaAnalyticsAdapter, {
  getTiming,
  getOrtb2Data,
  getPayload,
} from '../../../modules/agmaAnalyticsAdapter.js';

import { expect } from 'chai';
import * as events from '../../../src/events.js';
import { EVENTS } from '../../../src/constants.js';
import * as utils from 'src/utils.js';
import * as winDimensions from 'src/utils/winDimensions.js';
import * as viewport from 'libraries/viewport/viewport.js';
import { server } from '../../mocks/xhr.js';
import { config } from 'src/config.js';

const INGEST_URL = 'https://pbc.agma-analytics.de/v1';
const extendedKey = [
  'auctionIds',
  'code',
  'domain',
  'extended',
  'gdprApplies',
  'gdprConsentString',
  'language',
  'ortb2',
  'pageUrl',
  'pageViewId',
  'prebidVersion',
  'referrer',
  'screenHeight',
  'screenWidth',
  'deviceWidth',
  'deviceHeight',
  'scriptVersion',
  'timestamp',
  'timezoneOffset',
  'timing',
  'userIdsAsEids',
];
const nonExtendedKey = [
  'auctionIds',
  'code',
  'domain',
  'gdprApplies',
  'ortb2',
  'pageUrl',
  'pageViewId',
  'prebidVersion',
  'scriptVersion',
  'timing',
];
const CONSENT = {
  vendor: {
    gdprApplies: true,
    consentString: 'consentDataString',
    vendorData: { vendor: { consents: { 1122: true } } },
  },
  vendorDenied: {
    vendorData: { vendor: { consents: { 1122: false } } },
  },
  noVendorData: {
    gdprApplies: true,
    consentString: 'consentDataString',
  },
};

describe('AGMA Analytics Adapter', () => {
  let agmaConfig, sandbox, clock;

  const stubConsent = (consent) => sandbox.stub(gdprDataHandler, 'getConsentData').returns(consent);

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
    sandbox.stub(events, 'getEvents').returns([]);
    agmaConfig = {
      options: {
        code: 'test',
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('configuration', () => {
    it('registers itself with the adapter manager', () => {
      const adapter = adapterManager.getAnalyticsAdapter('agma');
      expect(adapter).to.exist;
      expect(adapter.gvlid).to.equal(1122);
    });
  });

  describe('getPayload', () => {
    it('should use non extended payload with no consent info', () => {
      stubConsent(null);
      const payload = getPayload([utils.generateUUID()], {
        code: 'test',
      });

      expect(payload).to.have.all.keys([...nonExtendedKey, 'debug']);
    });

    it('should use non extended payload when agma is not in  the TC String', () => {
      stubConsent(CONSENT.vendorDenied);
      const payload = getPayload([utils.generateUUID()], {
        code: 'test',
      });
      expect(payload).to.have.all.keys([...nonExtendedKey, 'debug']);
    });

    it('should use extended payload when agma is in the TC String', () => {
      stubConsent(CONSENT.vendor);
      const payload = getPayload([utils.generateUUID()], {
        code: 'test',
      });
      expect(payload).to.have.all.keys([...extendedKey, 'debug']);
    });

    it('takes the device size from getWinDimensions', () => {
      stubConsent(CONSENT.vendor);
      sandbox.stub(winDimensions, 'getWinDimensions').returns({ screen: { width: 111, height: 222 } });

      const payload = getPayload([utils.generateUUID()], { code: 'test' });

      expect(payload.deviceWidth).to.equal(111);
      expect(payload.deviceHeight).to.equal(222);
    });

    it('sends zero viewport sizes when the viewport is unavailable', () => {
      stubConsent(CONSENT.vendor);
      sandbox.stub(viewport, 'getViewportSize').returns({});

      const payload = getPayload([utils.generateUUID()], { code: 'test' });

      expect(payload.screenWidth).to.equal(0);
      expect(payload.screenHeight).to.equal(0);
    });
  });

  describe('getTiming', () => {
    let originalPerformance;

    const perf = (entry, now) => ({
      getEntriesByType: () => (entry ? [entry] : []),
      now: () => now,
    });

    beforeEach(() => {
      originalPerformance = global.performance;
    });

    afterEach(() => {
      global.performance = originalPerformance;
    });

    it('returns ttfb from the navigation entry', () => {
      global.performance = perf({ responseStart: 100, startTime: 50 }, 150);

      expect(getTiming()).to.deep.equal({ ttfb: 50, elapsedTime: 150 });
    });

    it('returns ttfb as 0 without a navigation entry', () => {
      global.performance = perf(undefined, 200);

      expect(getTiming()).to.deep.equal({ ttfb: 0, elapsedTime: 200 });
    });

    it('returns zeros when performance is unavailable', () => {
      global.performance = undefined;

      expect(getTiming()).to.deep.equal({ ttfb: 0, elapsedTime: 0 });
    });

    it('returns ttfb as 0 when it is negative or exceeds the elapsed time', () => {
      global.performance = perf({ responseStart: 50, startTime: 150 }, 200);
      expect(getTiming()).to.deep.equal({ ttfb: 0, elapsedTime: 200 });

      global.performance = perf({ responseStart: 50, startTime: 0 }, 40);
      expect(getTiming()).to.deep.equal({ ttfb: 0, elapsedTime: 40 });
    });
  });

  describe('getOrtb2Data', () => {
    it('returns site and user from options when available', () => {
      sandbox.stub(config, 'getAnyConfig').returns(undefined);

      const ortb2 = {
        user: 'user',
        site: 'site',
      };

      const result = getOrtb2Data({
        ortb2,
      });

      expect(result).to.deep.equal(ortb2);
    });

    it('returns a combination of data from options and pGlobal.readConfig', () => {
      sandbox.stub(config, 'getAnyConfig').withArgs('ortb2').returns({
        site: {
          foo: 'bar',
        },
      });

      const ortb2 = {
        user: 'user',
      };
      const result = getOrtb2Data({
        ortb2,
      });

      expect(result).to.deep.equal({
        site: {
          foo: 'bar',
        },
        user: 'user',
      });
    });

    it('prefers window.agma.ortb2 over options', () => {
      sandbox.stub(utils, 'getWindowSelf').returns({
        agma: {
          ortb2: {
            site: {
              domain: 'overwritten.com',
            },
          },
        },
      });

      const ortb2 = {
        site: {
          domain: 'initial.com'
        }
      };

      const result = getOrtb2Data({
        ortb2,
      });

      expect(result).to.deep.equal({
        user: undefined,
        site: {
          domain: 'overwritten.com',
        }
      });
    });
  });

  describe('when enabled', () => {
    beforeEach(() => {
      agmaAnalyticsAdapter.enableAnalytics({
        ...agmaConfig,
      });
      server.respondWith('POST', INGEST_URL, [
        200,
        {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        '',
      ]);
    });

    afterEach(() => {
      agmaAnalyticsAdapter.disableAnalytics();
    });

    describe('track', () => {
      it('counts an auction once and forgets it after AUCTION_END', () => {
        stubConsent(null);
        const auctionId = utils.generateUUID();

        events.emit(EVENTS.AUCTION_INIT, { auctionId });
        expect(agmaAnalyticsAdapter.started.has(auctionId)).to.be.true;
        events.emit(EVENTS.AUCTION_END, { auctionId });
        clock.tick(1100);

        expect(JSON.parse(server.requests[0].requestBody).auctionIds).to.deep.equal([auctionId]);
        expect(agmaAnalyticsAdapter.started.size).to.equal(0);
      });

      it('counts an auction that ends without AUCTION_INIT', () => {
        stubConsent(null);
        const auctionId = utils.generateUUID();

        events.emit(EVENTS.AUCTION_END, { auctionId });
        clock.tick(1100);

        expect(server.requests).to.have.length(1);
        expect(JSON.parse(server.requests[0].requestBody).auctionIds).to.deep.equal([auctionId]);
      });

      it('ignores events without an auction id', () => {
        agmaAnalyticsAdapter.track({ eventType: EVENTS.AUCTION_INIT, args: {} });

        expect(agmaAnalyticsAdapter.auctionIds).to.have.length(0);
      });

      it('ignores events other than auction start and end', () => {
        agmaAnalyticsAdapter.track({ eventType: EVENTS.BID_WON, args: { auctionId: utils.generateUUID() } });

        expect(agmaAnalyticsAdapter.auctionIds).to.have.length(0);
        expect(agmaAnalyticsAdapter.timer).to.be.null;
      });

      it('only receives auction start and end events from the base adapter', () => {
        const trackSpy = sandbox.spy(agmaAnalyticsAdapter, 'track');

        events.emit(EVENTS.BID_RESPONSE, { auctionId: utils.generateUUID() });
        expect(trackSpy.called).to.be.false;

        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        expect(trackSpy.calledOnce).to.be.true;
      });
    });

    describe('batching', () => {
      it('sends one request per batch window', () => {
        stubConsent(CONSENT.vendor);

        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        clock.tick(200);
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        clock.tick(900);

        const [request] = server.requests;
        const requestBody = JSON.parse(request.requestBody);
        expect(request.url).to.equal(INGEST_URL);
        expect(requestBody).to.have.all.keys(extendedKey);
        expect(requestBody.auctionIds).to.have.length(4);
        expect(server.requests).to.have.length(1);
      });

      it('recovers after a batch fails', () => {
        const getConsentData = sandbox.stub(gdprDataHandler, 'getConsentData').throws(new Error('consent lookup failed'));

        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        expect(() => clock.tick(1100)).to.throw('consent lookup failed');
        expect(agmaAnalyticsAdapter.timer).to.be.null;

        getConsentData.returns(null);
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        clock.tick(1100);
        expect(server.requests).to.have.length(1);
      });

      it('drops the pending batch on disable', () => {
        stubConsent(null);
        const auctionId = utils.generateUUID();

        events.emit(EVENTS.AUCTION_INIT, { auctionId });
        agmaAnalyticsAdapter.disableAnalytics();
        clock.tick(1100);

        expect(server.requests).to.have.length(0);
        expect(agmaAnalyticsAdapter.auctionIds).to.have.length(0);
        expect(agmaAnalyticsAdapter.started.size).to.equal(0);
        expect(agmaAnalyticsAdapter.timer).to.be.null;
      });

      it('sends with keepalive', () => {
        stubConsent(null);

        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        clock.tick(1100);

        expect(server.requests[0].fetch.request.keepalive).to.be.true;
      });

      it('flushes when the page is hidden, not when it becomes visible', () => {
        stubConsent(null);
        const visibilityState = sandbox.stub(document, 'visibilityState').value('visible');
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });

        document.dispatchEvent(new Event('visibilitychange'));
        expect(server.requests).to.have.length(0);

        visibilityState.value('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(server.requests).to.have.length(1);
      });

      it('flushes on pagehide until disabled', () => {
        stubConsent(null);
        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });

        window.dispatchEvent(new Event('pagehide'));
        expect(server.requests).to.have.length(1);
        window.dispatchEvent(new Event('pagehide'));
        expect(server.requests).to.have.length(1);

        const processBatch = sandbox.spy(agmaAnalyticsAdapter, 'processBatch');
        agmaAnalyticsAdapter.disableAnalytics();
        window.dispatchEvent(new Event('pagehide'));
        expect(processBatch.called).to.be.false;
      });
    });

    describe('enableAnalytics', () => {
      it('stays disabled without a code', () => {
        const logError = sandbox.stub(utils, 'logError');
        agmaAnalyticsAdapter.disableAnalytics();

        agmaAnalyticsAdapter.enableAnalytics({ provider: 'agma' });

        expect(agmaAnalyticsAdapter.enabled).to.be.false;
        expect(logError.calledOnce).to.be.true;
      });

      it('counts auctions regardless of publisher event filters', () => {
        stubConsent(null);
        agmaAnalyticsAdapter.disableAnalytics();
        agmaAnalyticsAdapter.enableAnalytics({
          provider: 'agma',
          options: { code: 'test' },
          includeEvents: [EVENTS.AUCTION_INIT],
          excludeEvents: [EVENTS.AUCTION_END],
        });

        events.emit(EVENTS.AUCTION_END, { auctionId: utils.generateUUID() });
        clock.tick(1100);

        expect(server.requests).to.have.length(1);
      });

      it('ignores the sampling option', () => {
        stubConsent(null);
        agmaAnalyticsAdapter.disableAnalytics();
        agmaAnalyticsAdapter.enableAnalytics({ provider: 'agma', options: { code: 'test', sampling: 0 } });

        events.emit(EVENTS.AUCTION_INIT, { auctionId: utils.generateUUID() });
        clock.tick(1100);

        expect(server.requests).to.have.length(1);
      });

      it('ignores the removed triggerEvent option', () => {
        stubConsent(null);
        const logWarn = sandbox.stub(utils, 'logWarn');
        agmaAnalyticsAdapter.disableAnalytics();
        agmaAnalyticsAdapter.enableAnalytics({
          provider: 'agma',
          options: {
            code: 'test',
            triggerEvent: EVENTS.AUCTION_END
          },
        });
        const auction = {
          auctionId: utils.generateUUID(),
        };

        events.emit(EVENTS.AUCTION_INIT, auction);
        events.emit(EVENTS.AUCTION_END, auction);
        clock.tick(1000);

        const [request] = server.requests;
        const requestBody = JSON.parse(request.requestBody);
        expect(request.url).to.equal(INGEST_URL);
        expect(requestBody.auctionIds).to.have.length(1);
        expect(requestBody).to.not.have.property('triggerEvent');
        expect(logWarn.calledOnce).to.be.true;
        expect(server.requests).to.have.length(1);
        expect(agmaAnalyticsAdapter.auctionIds).to.have.length(0);
      });
    });
  });
});
