#include "bindings/bindings.h"

#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <Network/Network.h>

#import "DevHostConfig.generated.h"

#ifndef PGSTUDIO_DEV_HOST_IP
/* Fallback only if Xcode script did not run; avoid 192.0.0.2 on device (iPadOS → lo0, never reaches Mac). */
#define PGSTUDIO_DEV_HOST_IP "127.0.0.1"
#endif

// Warm Local Network privacy before Tauri’s Rust dev proxy (reqwest) hits the Mac.
// Order: plain TCP (NWConnection) → brief Bonjour browse (NWBrowser) → URLSession on main + runloop.
static void pgstudio_prepare_local_network_access(void) {
  const char *host = PGSTUDIO_DEV_HOST_IP;
  const char *port = "3000";

  dispatch_queue_t net_q = dispatch_queue_create("com.pgstudio.helixdb.nw", DISPATCH_QUEUE_SERIAL);

  // 1) TCP to dev host: use Mac LAN IP from DevHostConfig (USB 192.0.0.2 is unreliable on iPadOS).
  nw_endpoint_t ep = nw_endpoint_create_host(host, port);
  nw_parameters_t tcp_params =
      nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL,
                                      NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_connection_t conn = nw_connection_create(ep, tcp_params);

  nw_connection_set_queue(conn, net_q);
  dispatch_semaphore_t conn_done = dispatch_semaphore_create(0);
  nw_connection_set_state_changed_handler(conn, ^(nw_connection_state_t state, nw_error_t error) {
    (void)error;
    if (state == nw_connection_state_ready || state == nw_connection_state_failed ||
        state == nw_connection_state_cancelled) {
      dispatch_semaphore_signal(conn_done);
    }
  });
  nw_connection_start(conn);
  dispatch_semaphore_wait(conn_done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)));
  nw_connection_cancel(conn);

  // 2) Short Bonjour browse — some iOS versions list the app under Local Network more reliably.
  nw_browse_descriptor_t desc =
      nw_browse_descriptor_create_bonjour_service("_http._tcp", NULL);
  nw_parameters_t browse_params = nw_parameters_create();
  nw_browser_t browser = nw_browser_create(desc, browse_params);

  dispatch_queue_t browse_q = dispatch_queue_create("com.pgstudio.helixdb.bonjour", DISPATCH_QUEUE_SERIAL);
  nw_browser_set_queue(browser, browse_q);
  dispatch_semaphore_t browse_done = dispatch_semaphore_create(0);
  nw_browser_start(browser);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), browse_q, ^{
    nw_browser_cancel(browser);
    dispatch_semaphore_signal(browse_done);
  });
  dispatch_semaphore_wait(browse_done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)));

  // 3) URLSession HEAD on main queue + runloop spin (second stack, matches prior behavior).
  NSString *urlString =
      [NSString stringWithFormat:@"http://%s:%s/", host, port];
  NSURL *url = [NSURL URLWithString:urlString];
  if (url == nil) {
    return;
  }
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = @"HEAD";
  req.timeoutInterval = 2.0;

  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  cfg.timeoutIntervalForRequest = 2.0;
  cfg.timeoutIntervalForResource = 2.0;

  __block BOOL finished = NO;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg
                                                        delegate:nil
                                                   delegateQueue:[NSOperationQueue mainQueue]];

  [[session dataTaskWithRequest:req
              completionHandler:^(NSData *_Nullable data, NSURLResponse *_Nullable response,
                                  NSError *_Nullable error) {
                (void)data;
                (void)response;
                (void)error;
                finished = YES;
              }] resume];

  NSDate *giveUp = [NSDate dateWithTimeIntervalSinceNow:2.5];
  while (!finished && [giveUp timeIntervalSinceNow] > 0) {
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                          beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
}
#endif

int main(int argc, char *argv[]) {
  (void)argc;
  (void)argv;
#if TARGET_OS_IOS
  pgstudio_prepare_local_network_access();
#endif
  ffi::start_app();
  return 0;
}
