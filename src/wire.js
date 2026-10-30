// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app: used by index.js and by the tests (so
// that the tests go through the same wiring). Every handler is registered
// before connect(). Read-only: no command handler, no poll.
// -----------------------------------------------------------------------------

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {import('./app.js').CaisoApp} app
 */
export function wire(gladys, app, logger) {
  // --- Discovery -----------------------------------------------------------------
  // A fixed list (the grid and the three hubs), never a read.
  gladys.onScanRequest(() => app.scan());
  // A device created: its fresh readings in memory are sent at once, and the
  // source it needs is read when its pace allows. Updated: nothing to send.
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.onDeviceDeleted(device));

  // --- Configuration changed by the user ------------------------------------------
  // Applied one after the other: the last one saved wins.
  gladys.onConfigUpdated((config) => {
    logger.info('Configuration updated');
    return app.configUpdated(config);
  });

  // --- Connection lifecycle --------------------------------------------------------
  // Every connection (the first one and each reconnection) reads the
  // configuration (tried again without end while Gladys cannot give it), then
  // publishes the Discovery list and the status again; the reads keep their
  // pace (never sooner than the interval after the last one).
  gladys.on('connected', () => {
    app
      .connected(() => gladys.getConfig())
      .catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
  });
  gladys.on('disconnected', () => {
    app.disconnected().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  gladys.handleShutdown(() => app.stop());
}
