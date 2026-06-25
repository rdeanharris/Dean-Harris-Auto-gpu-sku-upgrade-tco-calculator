(function () {
  "use strict";

  if (window.supabase && typeof window.supabase.createClient === "function") {
    return;
  }

  function toError(payload, fallbackMessage) {
    const message = payload?.error_description || payload?.msg || payload?.message || fallbackMessage || "Supabase request failed.";
    return { message };
  }

  function normalizeSession(payload) {
    if (!payload || !payload.access_token) return null;
    const expiresIn = Number(payload.expires_in || 0);
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || "",
      token_type: payload.token_type || "bearer",
      expires_in: expiresIn,
      expires_at: Number(payload.expires_at || Math.floor(Date.now() / 1000) + expiresIn),
      user: payload.user || null,
    };
  }

  class LocalSupabaseClient {
    constructor(projectUrl, anonKey) {
      this.projectUrl = String(projectUrl || "").replace(/\/+$/, "");
      this.anonKey = String(anonKey || "");
      this.storageKey = "gpu-tco-supabase-session:" + this.projectUrl;
      this.authListeners = new Set();
      this.auth = {
        getSession: this.getSession.bind(this),
        onAuthStateChange: this.onAuthStateChange.bind(this),
        resetPasswordForEmail: this.resetPasswordForEmail.bind(this),
        resend: this.resend.bind(this),
        signInWithOAuth: this.signInWithOAuth.bind(this),
        signInWithPassword: this.signInWithPassword.bind(this),
        signOut: this.signOut.bind(this),
        signUp: this.signUp.bind(this),
        updateUser: this.updateUser.bind(this),
      };
    }

    from(tableName) {
      return new LocalQueryBuilder(this, tableName);
    }

    getSessionFromStorage() {
      try {
        const session = JSON.parse(localStorage.getItem(this.storageKey) || "null");
        if (!session?.access_token) return null;
        if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000)) {
          localStorage.removeItem(this.storageKey);
          return null;
        }
        return session;
      } catch (_error) {
        localStorage.removeItem(this.storageKey);
        return null;
      }
    }

    saveSession(session) {
      if (session?.access_token) {
        localStorage.setItem(this.storageKey, JSON.stringify(session));
      } else {
        localStorage.removeItem(this.storageKey);
      }
    }

    notifyAuthListeners(event, session) {
      this.authListeners.forEach((listener) => {
        try {
          listener(event, session);
        } catch (_error) {
          // Keep one failing callback from breaking the page.
        }
      });
    }

    authHeaders(includeSession = false) {
      const headers = {
        apikey: this.anonKey,
        "Content-Type": "application/json",
      };
      const session = this.getSessionFromStorage();
      const token = includeSession ? session?.access_token : this.anonKey;
      if (token) headers.Authorization = "Bearer " + token;
      return headers;
    }

    restHeaders() {
      const session = this.getSessionFromStorage();
      return {
        apikey: this.anonKey,
        Authorization: "Bearer " + (session?.access_token || this.anonKey),
      };
    }

    async request(path, init = {}) {
      const response = await fetch(this.projectUrl + path, init);
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          payload = { message: text };
        }
      }
      if (!response.ok) {
        return { data: null, error: toError(payload, response.statusText) };
      }
      return { data: payload, error: null };
    }

    async getSession() {
      return { data: { session: this.getSessionFromStorage() }, error: null };
    }

    onAuthStateChange(callback) {
      this.authListeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe: () => this.authListeners.delete(callback),
          },
        },
      };
    }

    async signUp(credentials) {
      const redirectTo = credentials.options?.emailRedirectTo || credentials.options?.redirectTo || "";
      const path = "/auth/v1/signup" + (redirectTo ? "?redirect_to=" + encodeURIComponent(redirectTo) : "");
      const { data, error } = await this.request(path, {
        method: "POST",
        headers: this.authHeaders(false),
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });
      if (error) return { data: { user: null, session: null }, error };
      const session = normalizeSession(data);
      if (session) {
        this.saveSession(session);
        this.notifyAuthListeners("SIGNED_IN", session);
      }
      return { data: { user: data?.user || session?.user || null, session }, error: null };
    }

    async resend(params) {
      const redirectTo = params.options?.emailRedirectTo || params.options?.redirectTo || "";
      const path = "/auth/v1/resend" + (redirectTo ? "?redirect_to=" + encodeURIComponent(redirectTo) : "");
      const { data, error } = await this.request(path, {
        method: "POST",
        headers: this.authHeaders(false),
        body: JSON.stringify({
          type: params.type || "signup",
          email: params.email,
        }),
      });
      return { data, error };
    }

    async signInWithOAuth(params) {
      const provider = encodeURIComponent(params.provider || "");
      if (!provider) return { data: null, error: { message: "Missing OAuth provider." } };
      const query = new URLSearchParams({ provider });
      const redirectTo = params.options?.redirectTo || "";
      const scopes = params.options?.scopes || "";
      if (redirectTo) query.set("redirect_to", redirectTo);
      if (scopes) query.set("scopes", scopes);
      const url = this.projectUrl + "/auth/v1/authorize?" + query.toString();
      window.location.assign(url);
      return { data: { url }, error: null };
    }

    async signInWithPassword(credentials) {
      const { data, error } = await this.request("/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: this.authHeaders(false),
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });
      if (error) return { data: { user: null, session: null }, error };
      const session = normalizeSession(data);
      this.saveSession(session);
      this.notifyAuthListeners("SIGNED_IN", session);
      return { data: { user: session?.user || null, session }, error: null };
    }

    async resetPasswordForEmail(email, options = {}) {
      const redirect = options.redirectTo ? "?redirect_to=" + encodeURIComponent(options.redirectTo) : "";
      const { error } = await this.request("/auth/v1/recover" + redirect, {
        method: "POST",
        headers: this.authHeaders(false),
        body: JSON.stringify({ email }),
      });
      return { data: null, error };
    }

    async updateUser(attributes) {
      const session = this.getSessionFromStorage();
      if (!session) return { data: { user: null }, error: { message: "Sign in before updating user details." } };
      const { data, error } = await this.request("/auth/v1/user", {
        method: "PUT",
        headers: this.authHeaders(true),
        body: JSON.stringify(attributes),
      });
      if (error) return { data: { user: null }, error };
      const updatedSession = { ...session, user: data?.user || data || session.user };
      this.saveSession(updatedSession);
      this.notifyAuthListeners("USER_UPDATED", updatedSession);
      return { data: { user: updatedSession.user }, error: null };
    }

    async signOut() {
      const session = this.getSessionFromStorage();
      if (session) {
        await this.request("/auth/v1/logout", {
          method: "POST",
          headers: this.authHeaders(true),
        });
      }
      this.saveSession(null);
      this.notifyAuthListeners("SIGNED_OUT", null);
      return { error: null };
    }
  }

  class LocalQueryBuilder {
    constructor(client, tableName) {
      this.client = client;
      this.tableName = tableName;
      this.method = "GET";
      this.columns = "*";
      this.filters = [];
      this.orderClause = "";
      this.payload = undefined;
      this.returnSingle = false;
    }

    select(columns) {
      this.columns = columns || "*";
      return this;
    }

    eq(column, value) {
      this.filters.push({ column, operator: "eq", value });
      return this;
    }

    order(column, options = {}) {
      this.orderClause = column + "." + (options.ascending ? "asc" : "desc");
      return this;
    }

    insert(payload) {
      this.method = "POST";
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.method = "PATCH";
      this.payload = payload;
      return this;
    }

    delete() {
      this.method = "DELETE";
      return this;
    }

    maybeSingle() {
      this.returnSingle = true;
      return this;
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    catch(reject) {
      return this.execute().catch(reject);
    }

    finally(callback) {
      return this.execute().finally(callback);
    }

    async execute() {
      const params = new URLSearchParams();
      params.set("select", this.columns);
      this.filters.forEach((filter) => {
        params.append(filter.column, filter.operator + "." + filter.value);
      });
      if (this.orderClause) params.set("order", this.orderClause);
      const headers = this.client.restHeaders();
      headers.Accept = "application/json";
      if (this.method !== "GET") {
        headers["Content-Type"] = "application/json";
        headers.Prefer = "return=representation";
      }
      const init = { method: this.method, headers };
      if (this.payload !== undefined) init.body = JSON.stringify(this.payload);
      const { data, error } = await this.client.request("/rest/v1/" + encodeURIComponent(this.tableName) + "?" + params.toString(), init);
      if (error) return { data: null, error };
      if (this.returnSingle) {
        return { data: Array.isArray(data) ? data[0] || null : data || null, error: null };
      }
      return { data: data || [], error: null };
    }
  }

  window.supabase = {
    createClient: (projectUrl, anonKey) => new LocalSupabaseClient(projectUrl, anonKey),
  };
  window.supabaseLocalFallback = true;
})();
