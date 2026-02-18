(function (global) {
  const YiDimension = {
    socket: null,
    isConnected: false,
    isIMReady: false,

    onLog: null,
    onStatusChange: null,

    _retry: 0,
    _url: "",
    _token: "",

    _emitLog(level, msg, extra) {
      try {
        const tail = extra ? " " + JSON.stringify(extra) : "";
        this.onLog && this.onLog(level, msg + tail);
      } catch (_) {}
    },

    _emitStatus() {
      try { this.onStatusChange && this.onStatusChange(this.isConnected, this.isIMReady); } catch (_) {}
    },

    _buildWsUrl() {
      if (global.YIDIMENSION_WS_URL) return String(global.YIDIMENSION_WS_URL);
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const host = location.hostname;
      return `${protocol}://${host}:3001`;
    },

    connect() {
      const url = this._buildWsUrl();
      this._url = url;

      this._emitLog("ws", `正在连接服务器: ${url}`, { retry: this._retry });

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._emitLog("error", "WebSocket 构造失败", { url, message: e?.message || String(e) });
        return this._scheduleReconnect();
      }
      this.socket = ws;

      ws.onopen = () => {
        this.isConnected = true;
        this.isIMReady = false;
        this._retry = 0;
        this._emitLog("ws", "服务器连接成功", { url });
        this._emitStatus();
      };

      ws.onmessage = (event) => {
        let data = null;
        try { data = JSON.parse(event.data); } catch (_) {}

        if (!data) {
          this._emitLog("warn", "收到非 JSON 消息", { raw: String(event.data).slice(0, 200) });
          return;
        }

        if (data.type === "status") {
          this.isIMReady = !!(data.isReady ?? data.imReady ?? false);
          this._emitLog("info", "收到状态", data);
          this._emitStatus();
          return;
        }

        if (data.type === "log") {
          this._emitLog(data.level || "info", data.msg || "server log", data.extra || null);
          return;
        }

        this._emitLog("info", "收到消息", data);
      };

      ws.onerror = () => {
        this._emitLog("error", "WebSocket 发生错误", {
          url: this._url,
          readyState: ws.readyState
        });
      };

      ws.onclose = (evt) => {
        this.isConnected = false;
        this.isIMReady = false;
        this._emitStatus();

        this._emitLog("error", "服务器连接断开", {
          url: this._url,
          code: evt?.code,
          reason: evt?.reason,
          wasClean: evt?.wasClean,
          readyState: ws.readyState
        });

        this._scheduleReconnect();
      };
    },

    _scheduleReconnect() {
      this._retry += 1;
      this._emitLog("ws", "3秒后尝试重连...", { retry: this._retry, url: this._url });
      setTimeout(() => this.connect(), 3000);
    },

    login(uid, token) {
      if (!this.socket || this.socket.readyState !== 1) {
        this._emitLog("warn", "WS 未连接，无法 login（等重连成功后再点登录）");
        return;
      }
      this._token = String(token || "").trim();

      this._emitLog("info", `开始登录（UID: ${uid}）`);
      this.socket.send(JSON.stringify({ type: "login", uid, token }));
    },

    // 固定发送“开发游戏”协议：game_cmd
    send(commandId) {
      if (!this.socket || this.socket.readyState !== 1) {
        this._emitLog("warn", "WS 未连接，无法 send");
        return;
      }
      if (!this.isIMReady) {
        this._emitLog("warn", "IM 未就绪，无法 send");
        return;
      }

      const token = String(this._token || "").trim();
      const id = String(commandId ?? "").trim();

      if (!token) {
        this._emitLog("warn", "token 为空：请先登录");
        return;
      }
      if (!id) {
        this._emitLog("warn", "commandId 为空，已取消发送");
        return;
      }

      const payload = { code: 'game_cmd', id, token };
      this._emitLog('info', '发送指令(game_cmd)', payload);
      this.socket.send(JSON.stringify({ type: 'sendCommand', payload }));
    },

    logout() {
      try {
        if (this.socket && this.socket.readyState === 1) {
          this.socket.send(JSON.stringify({ type: "logout" }));
        }
      } catch (_) {}
    }
  };

  global.YiDimension = YiDimension;
})(window);
