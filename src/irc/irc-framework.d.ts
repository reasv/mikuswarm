/**
 * Local module declaration for `irc-framework`.
 *
 * irc-framework is a plain JavaScript CommonJS package with no published types
 * (@types/irc-framework does not exist). This declaration covers only the
 * surface used by the IRC provider — do not expand it unless a new call site
 * needs it (spec §7.1 "local .d.ts covering only the surface it uses").
 *
 * Verified against:
 *   node_modules/irc-framework/src/client.js
 *   node_modules/irc-framework/src/networkinfo.js
 *   node_modules/irc-framework/src/commands/handlers/registration.js
 *   node_modules/irc-framework/src/commands/handlers/messaging.js
 *   node_modules/irc-framework/src/index.js
 *
 * Export shape: irc-framework exports `{ Client, ... }` via `module.exports.X = …`.
 * With `esModuleInterop: true`, `import IrcFramework from "irc-framework"` gives
 * you the module.exports object. All types are placed in the `IrcFramework`
 * namespace so `IrcFramework.Client`, `IrcFramework.IrcConnectOptions`, etc. work.
 */

declare module "irc-framework" {
  namespace IrcFramework {
    // ── Network info (client.network) ───────────────────────────────────────

    interface IrcNetworkCap {
      /** Fully enabled caps (post CAP ACK). */
      enabled: string[];
      /** Caps advertised by the server in CAP LS (including those not requested). */
      available: Map<string, string>;
      isEnabled(cap: string): boolean;
    }

    interface IrcNetworkInfo {
      /** NETWORK ISUPPORT token, or "Network" when absent. */
      name: string;
      /** Reporting server name from RPL_WELCOME. */
      server: string;
      /** IRCd version string from RPL_YOURHOST. */
      ircd: string;
      /** ISUPPORT tokens — keys are uppercased token names, values are token values. */
      options: Record<string, string | boolean | string[]>;
      cap: IrcNetworkCap;
      /**
       * Returns the ISUPPORT option value for the given name (case-insensitive look-up).
       * Returns the value string, true (for presence-only tokens), or undefined.
       */
      supports(name: string): string | boolean | undefined;
    }

    // ── Connected user state (client.user) ────────────────────────────────

    interface IrcUser {
      nick: string;
      username: string;
      host: string;
      away: boolean;
    }

    // ── Event payloads ────────────────────────────────────────────────────

    interface PrivmsgEvent {
      /** True when the source is the server itself (no nick). */
      from_server: boolean;
      nick: string;
      ident: string;
      hostname: string;
      target: string;
      message: string;
      /** Decoded IRCv3 message tags. */
      tags: Record<string, string>;
      /** Server-time as ms-epoch, or Date.now() when server-time is absent. */
      time: number;
      /** Services account name from account-tag, if present. */
      account?: string;
    }

    /** CTCP ACTION (/me) event — same shape as PrivmsgEvent, message = action text. */
    type ActionEvent = PrivmsgEvent;

    /** NOTICE event. */
    type NoticeEvent = PrivmsgEvent;

    interface TagmsgEvent {
      from_server: boolean;
      nick: string;
      ident: string;
      hostname: string;
      target: string;
      tags: Record<string, string>;
      time: number;
      account?: string;
    }

    interface RegisteredEvent {
      nick: string;
      tags: Record<string, string>;
    }

    interface NickEvent {
      nick: string;
      new_nick: string;
      ident: string;
      hostname: string;
      tags: Record<string, string>;
      time: number;
    }

    interface QuitEvent {
      nick: string;
      ident: string;
      hostname: string;
      message: string;
      tags: Record<string, string>;
      time: number;
    }

    /**
     * Emitted by irc-framework for CHGHOST and SETNAME commands when
     * `enable_chghost` or `enable_setname` is true (handlers/user.js:48/64).
     * For CHGHOST: new_ident and new_hostname are set.
     * For SETNAME: new_gecos is set.
     */
    interface UserUpdatedEvent {
      nick: string;
      ident: string;
      hostname: string;
      new_ident?: string;
      new_hostname?: string;
      new_gecos?: string;
      tags: Record<string, string>;
      time: number;
    }

    interface JoinEvent {
      nick: string;
      ident: string;
      hostname: string;
      channel: string;
      /** Services account name from extended-join, if present. */
      account?: string;
      /** Real name from extended-join, if present. */
      gecos?: string;
      tags: Record<string, string>;
      time: number;
    }

    interface PartEvent {
      nick: string;
      ident: string;
      hostname: string;
      channel: string;
      message: string;
      tags: Record<string, string>;
      time: number;
    }

    interface WholistUser {
      nick: string;
      ident: string;
      hostname: string;
      account?: string;
    }

    interface WholistEvent {
      target: string;
      users: WholistUser[];
    }

    /** Emitted for cap ls / cap ack / cap nak / cap del / cap new events. */
    interface CapEvent {
      command: string;
      /** Map from cap name to cap value (may be empty string). */
      capabilities: Record<string, string>;
    }

    // ── Connection options ────────────────────────────────────────────────

    interface IrcConnectOptions {
      host: string;
      port?: number;
      tls?: boolean;
      nick: string;
      username?: string;
      gecos?: string;
      /** Server password (PASS command). */
      password?: string;
      /**
       * SASL PLAIN credentials. When `account.account` is present, the library
       * adds "sasl" to its cap want list and performs AUTHENTICATE PLAIN using
       * `account.account` as the username and `account.password` as the password.
       */
      account?: { account: string; password: string };
      /** Request echo-message cap. Default false. */
      enable_echomessage?: boolean;
      /** Request chghost cap. Default false. */
      enable_chghost?: boolean;
      /** Request setname cap. Default false. */
      enable_setname?: boolean;
      /** Disconnect immediately on SASL failure. Default false. */
      sasl_disconnect_on_fail?: boolean;
      /** Auto-reconnect on disconnect. Default true. */
      auto_reconnect?: boolean;
      /** Max reconnect wait in ms. Default 300000. */
      auto_reconnect_max_wait?: number;
      /** Max reconnect retries before giving up (0 = unlimited). Default 3. */
      auto_reconnect_max_retries?: number;
      /**
       * Byte budget for the message body (content only; excludes `:source PRIVMSG target :`).
       * The library splits lines longer than this. Default 350.
       * Set to a high value when pre-chunking manually.
       */
      message_max_length?: number;
      /** CTCP VERSION reply string. */
      version?: string;
      /** IRC encoding. Default "utf8". */
      encoding?: string;
    }

    // ── Client class ────────────────────────────────────────────────────

    class Client {
      /** State of the connected user (nick, username, host). */
      user: IrcUser;
      /** Network information (ISUPPORT tokens, caps). */
      network: IrcNetworkInfo;
      /** True when the underlying socket is connected. */
      connected: boolean;

      constructor(options?: IrcConnectOptions);

      /**
       * Request additional capabilities on the next connection's CAP LS exchange.
       * Must be called BEFORE `connect()`.
       */
      requestCap(cap: string | string[]): void;

      /** Connect (or reconnect) to the server. */
      connect(options?: IrcConnectOptions): void;

      /** Send QUIT with an optional message. */
      quit(message?: string): void;

      /**
       * Send PRIVMSG. The `tags` argument is serialized as IRCv3 message tags.
       * Pass `{ label: "..." }` for labeled-response correlation.
       */
      say(target: string, message: string, tags?: Record<string, string>): void;

      /** Send NOTICE. */
      notice(target: string, message: string, tags?: Record<string, string>): void;

      /**
       * Send TAGMSG (tags-only message with no body). Used for typing indicators.
       * The `tags` object must contain at least one client tag (e.g. `{ "+typing": "active" }`).
       */
      tagmsg(target: string, tags?: Record<string, string>): void;

      /** Send a raw IRC line. */
      raw(command: string, ...args: string[]): void;

      /** Send JOIN. */
      join(channel: string, key?: string): void;

      /** Send PART. */
      part(channel: string, message?: string): void;

      /**
       * Send WHO and fire `cb` when the `wholist` event for `target` arrives.
       * The library queues WHO requests to run serially.
       */
      who(target: string, cb?: (event: WholistEvent) => void): void;

      /** Send WHOIS and fire `cb` when the `whois` event for `target` arrives. */
      whois(target: string, cb?: (event: unknown) => void): void;

      // ── Event emitter ─────────────────────────────────────────────────

      on(event: "registered", listener: (event: RegisteredEvent) => void): this;
      /** "connected" is an alias for "registered" emitted by addCommandHandlerListeners. */
      on(event: "connected", listener: (event: RegisteredEvent) => void): this;
      on(event: "close", listener: () => void): this;
      on(event: "socket close", listener: () => void): this;
      on(event: "socket error", listener: (error: Error) => void): this;
      on(event: "reconnecting", listener: (opts: { delay: number; attempt: number }) => void): this;
      on(event: "privmsg", listener: (event: PrivmsgEvent) => void): this;
      on(event: "action", listener: (event: ActionEvent) => void): this;
      on(event: "notice", listener: (event: NoticeEvent) => void): this;
      on(event: "tagmsg", listener: (event: TagmsgEvent) => void): this;
      on(event: "nick", listener: (event: NickEvent) => void): this;
      on(event: "quit", listener: (event: QuitEvent) => void): this;
      on(event: "join", listener: (event: JoinEvent) => void): this;
      on(event: "part", listener: (event: PartEvent) => void): this;
      on(event: "wholist", listener: (event: WholistEvent) => void): this;
      on(event: "cap del", listener: (event: CapEvent) => void): this;
      on(event: "cap ack", listener: (event: CapEvent) => void): this;
      on(event: "cap ls", listener: (event: CapEvent) => void): this;
      on(event: "cap new", listener: (event: CapEvent) => void): this;
      /** Emitted for CHGHOST and SETNAME when enable_chghost / enable_setname is true. */
      on(event: "user updated", listener: (event: UserUpdatedEvent) => void): this;
      on(event: "ping timeout", listener: () => void): this;
      on(event: string, listener: (...args: unknown[]) => void): this;

      once(event: string, listener: (...args: unknown[]) => void): this;
      off(event: string, listener: (...args: unknown[]) => void): this;
      removeListener(event: string, listener: (...args: unknown[]) => void): this;
      removeAllListeners(event?: string): this;
    }
  }

  export = IrcFramework;
}
