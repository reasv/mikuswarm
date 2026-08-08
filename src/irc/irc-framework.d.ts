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
 *   node_modules/irc-framework/src/commands/handlers/user.js   (ACCOUNT, CHGHOST)
 *   node_modules/irc-framework/src/commands/handlers/channel.js (extended-join)
 *   node_modules/irc-framework/src/commands/handlers/misc.js    (RPL_WHOSPCRPL → wholist)
 *   node_modules/irc-framework/src/index.js
 *
 * Export shape: irc-framework exports `{ Client, ... }` via `module.exports.X = …`.
 * With `esModuleInterop: true`, `import IrcFramework from "irc-framework"` gives
 * you the module.exports object. All types are placed in the `IrcFramework`
 * namespace so `IrcFramework.Client`, `IrcFramework.IrcConnectOptions`, etc. work.
 *
 * Account field semantics across events:
 *   - JoinEvent.account / AccountEvent.account: the library maps the IRC protocol
 *     value `"*"` (not identified) to JavaScript `false`, and a real account name
 *     remains a string. The field is `undefined` when the relevant cap is not enabled
 *     (extended-join for JOIN events; account-notify for ACCOUNT messages).
 *     Source: handlers/user.js and handlers/channel.js:
 *       `const account = command.params[0] === '*' ? false : command.params[0];`
 *       `data.account = command.params[1] === '*' ? false : command.params[1];`
 *   - WholistUser.account (WHOX): library maps `"0"` → `""` (empty string).
 *     Source: misc.js line 173: `account: params[9] === '0' ? '' : params[9]`
 *     Non-WHOX WHO responses have no account field (undefined).
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
      /** Undefined when no server-time tag (library returns undefined explicitly). */
      time?: number;
    }

    interface QuitEvent {
      nick: string;
      ident: string;
      hostname: string;
      message: string;
      tags: Record<string, string>;
      /** Undefined when no server-time tag (library returns undefined explicitly). */
      time?: number;
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
      /**
       * Services account from extended-join cap (when the cap is enabled).
       *   - `string` → user is identified with this account name.
       *   - `false` → user is NOT identified (library maps protocol `"*"` → JS `false`).
       *   - `undefined` → extended-join cap not enabled; account information unavailable.
       *
       * Source: handlers/channel.js line 219:
       *   `data.account = command.params[1] === '*' ? false : command.params[1];`
       */
      account?: string | false;
      /** Real name from extended-join, if present. */
      gecos?: string;
      tags: Record<string, string>;
      time: number;
    }

    /**
     * Emitted for the ACCOUNT message (account-notify cap).
     * Sent by the server when a visible user logs into or out of services.
     *
     * Source: handlers/user.js lines 25–40:
     *   `const account = command.params[0] === '*' ? false : command.params[0];`
     *   `handler.emit('account', { nick, ident, hostname, account, time, tags })`
     */
    interface AccountEvent {
      nick: string;
      ident: string;
      hostname: string;
      /**
       *   - `string` → user logged in with this account name.
       *   - `false` → user logged out (library maps protocol `"*"` → JS `false`).
       */
      account: string | false;
      time: number;
      tags: Record<string, string>;
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

    /**
     * Emitted as `userlist` when RPL_ENDOFNAMES arrives (after RPL_NAMEREPLY
     * lines have been collected for the channel).
     * Source: handlers/channel.js:84–93.
     */
    interface UserlistEvent {
      channel: string;
      users: Array<{
        nick: string;
        ident: string;
        hostname: string;
        /** Mode letters active for this user in this channel (e.g. ['o', 'v']). */
        modes: string[];
        tags: Record<string, string>;
      }>;
      tags: Record<string, string>;
    }

    /**
     * Emitted for TOPIC command, RPL_TOPIC (332), and RPL_NOTOPIC (331).
     * `nick` is present only for live TOPIC changes (absent for 332/331).
     * Source: handlers/channel.js:179–295.
     */
    interface TopicEvent {
      channel: string;
      topic: string;
      nick?: string;
      time?: number;
      tags: Record<string, string>;
    }

    /**
     * Emitted when a user is kicked from a channel.
     * Source: handlers/channel.js:249–263.
     */
    interface KickEvent {
      /** Nick that was kicked. */
      kicked: string;
      /** Nick that did the kicking. */
      nick: string;
      channel: string;
      message: string;
      time: number;
      tags: Record<string, string>;
    }

    /**
     * Emitted by the `away` event when a user goes away (AWAY command with a message,
     * or RPL_NOWAWAY 306 for self). The `self` field is true when this is the bot's
     * own away confirmation. Source: handlers/user.js:75–108.
     */
    interface AwayEvent {
      self: boolean;
      nick: string;
      message: string;
      time: number;
      tags: Record<string, string>;
    }

    /**
     * Emitted by the `back` event when a user comes back (AWAY with no message,
     * or RPL_UNAWAY 305 for self). Source: handlers/user.js:75–122.
     */
    interface BackEvent {
      self: boolean;
      nick: string;
      message: string;
      time: number;
      tags: Record<string, string>;
    }

    /**
     * Assembled WHOIS result emitted as the `whois` event when RPL_ENDOFWHOIS
     * arrives. Fields are populated piecemeal by the numeric handlers; absent
     * means the server did not send the corresponding numeric.
     * Source: handlers/user.js:147–158, 185–311.
     */
    interface WhoisResult {
      nick: string;
      ident?: string;
      hostname?: string;
      real_name?: string;
      /** Away message when the user is away (from RPL_AWAY 301 during WHOIS). */
      away?: string;
      /**
       * Raw RPL_WHOISCHANNELS (319) string: e.g. "@#general +#other".
       * Each space-separated token is `<prefixes><#channel>`.
       */
      channels?: string;
      /** Services account name from RPL_WHOISACCOUNT (330). */
      account?: string;
      /** Set to "not_found" when the nick does not exist on the network. */
      error?: string;
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
      whois(target: string, cb?: (event: WhoisResult) => void): void;

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
      /** ACCOUNT message (account-notify cap) — user logged in/out of services. */
      on(event: "account", listener: (event: AccountEvent) => void): this;
      on(event: "wholist", listener: (event: WholistEvent) => void): this;
      on(event: "userlist", listener: (event: UserlistEvent) => void): this;
      on(event: "topic", listener: (event: TopicEvent) => void): this;
      on(event: "kick", listener: (event: KickEvent) => void): this;
      on(event: "away", listener: (event: AwayEvent) => void): this;
      on(event: "back", listener: (event: BackEvent) => void): this;
      on(event: "whois", listener: (event: WhoisResult) => void): this;
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
