// Browser half of dsh-lan-access: a "局域网访问" page in Settings.
//
// Hand-written client bundle (no build step). The client module system loads
// bundles registered through `window.__ModuleLoader__.load({ id, factory })`
// and materializes the factory's `module.exports`, using its `inject` array as
// cordis fiber requirements and calling `apply(ctx)` once services exist.
//
// The page talks to the same-origin Host route the plugin registers on the
// official webServer (`/lan-access/config`); that route admits only the owner
// browser, so the page works in the desktop window and in an already-signed-in
// LAN browser without any additional authentication.
window.__ModuleLoader__.load({
  id: 'dsh-lan-access',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const API = '/lan-access/config';

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' },
      intro: { color: 'var(--dsh-text-secondary, #8a919c)', fontSize: '13px', lineHeight: '1.5', margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '13px', fontWeight: 600, color: 'var(--dsh-text-primary, #e6e6e6)' },
      hint: { fontSize: '12px', color: 'var(--dsh-text-secondary, #8a919c)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #3a3f47)',
        background: 'var(--dsh-surface, #14161a)',
        color: 'var(--dsh-text-primary, #e6e6e6)',
        fontSize: '13px',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: {
        padding: '8px 16px',
        border: 0,
        borderRadius: '6px',
        background: 'var(--dsh-accent, #4c8dff)',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.6, cursor: 'default' },
      status: { fontSize: '13px', lineHeight: '1.5' },
      warn: { color: '#e3b341' },
      ok: { color: '#3fb950' },
      error: { color: '#ff7b72' },
      code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
    };

    function Field(props) {
      return h('div', { style: styles.row },
        h('label', { style: styles.label }, props.label),
        props.hint ? h('div', { style: styles.hint }, props.hint) : null,
        h('input', {
          style: props.disabled ? { ...styles.input, opacity: 0.6 } : styles.input,
          type: props.type ?? 'text',
          value: props.value,
          placeholder: props.placeholder ?? '',
          disabled: props.disabled === true,
          autoComplete: props.autoComplete ?? 'off',
          onChange: (event) => props.onChange(event.target.value),
          spellCheck: false,
        }));
    }

    function LanAccessSection() {
      const [state, setState] = React.useState({ loading: true, error: '', view: undefined });
      const [form, setForm] = React.useState({ lanHost: '', port: '', allowCidrs: '', password: '' });
      const [status, setStatus] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);

      const load = React.useCallback(() => {
        setState({ loading: true, error: '', view: undefined });
        fetch(API, { credentials: 'same-origin' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((view) => {
            setForm({
              lanHost: view.lanHost ?? '',
              port: view.port === null || view.port === undefined ? '' : String(view.port),
              allowCidrs: Array.isArray(view.allowCidrs) ? view.allowCidrs.join(', ') : '',
              password: '',
            });
            setState({ loading: false, error: '', view });
          })
          .catch((error) => setState({ loading: false, error: String(error && error.message ? error.message : error), view: undefined }));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const save = () => {
        setSaving(true);
        setStatus(undefined);
        const body = {
          lanHost: form.lanHost.trim(),
          port: Number(form.port),
          allowCidrs: form.allowCidrs.split(',').map((value) => value.trim()).filter(Boolean),
        };
        if (form.password.length > 0) body.password = form.password;
        fetch(API, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.ok !== true) {
              throw new Error(payload.error ?? `HTTP ${response.status}`);
            }
            return payload;
          })
          .then((payload) => {
            setStatus({ kind: 'ok', text: payload.restartRequired
              ? '已保存。绑定地址或端口的变化需要重启应用后生效。'
              : '已保存并立即生效。' });
            setForm((current) => ({ ...current, password: '' }));
            if (payload.view) setState({ loading: false, error: '', view: payload.view });
          })
          .catch((error) => setStatus({ kind: 'error', text: `保存失败：${error.message}` }))
          .finally(() => setSaving(false));
      };

      if (state.loading) return h('div', { style: styles.hint }, '加载中…');
      if (state.error) {
        return h('div', { style: styles.page },
          h('div', { style: { ...styles.status, ...styles.error } }, `无法读取设置：${state.error}`),
          h('div', null, h('button', { style: styles.button, onClick: load }, '重试')));
      }

      const view = state.view;
      const patchPinned = view.patchOverrides === true;
      const disabled = saving || patchPinned;

      return h('div', { style: styles.page },
        h('p', { style: styles.intro },
          '在局域网地址上提供与桌面端相同的 Web UI。只有通过本页设置的密码（以及 IP 白名单）才能访问；',
          '登录成功即拥有该实例的完整操作权限。'),
        view.configured
          ? null
          : h('div', { style: { ...styles.status, ...styles.warn } }, '当前尚未配置密码，局域网入口处于关闭状态。设置密码并保存后重启应用即可启用。'),
        patchPinned
          ? h('div', { style: { ...styles.status, ...styles.warn } },
            '当前配置由 profile patch（cordis.patch.yml）固定，本页只读。请从 patch 中移除该条目的 config 后再使用本页编辑。')
          : null,
        view.listening
          ? h('div', { style: { ...styles.status, ...styles.ok } }, `正在监听 http://${view.lanHost}:${view.port}`)
          : null,
        Field({
          label: '绑定地址',
          hint: `必须是本机网卡 IPv4 之一：${(view.hosts ?? []).join(' / ')}`,
          value: form.lanHost,
          disabled,
          onChange: (value) => setForm((current) => ({ ...current, lanHost: value })),
        }),
        Field({
          label: '端口',
          hint: '绑定地址或端口修改后需要重启应用生效。',
          type: 'number',
          value: form.port,
          disabled,
          onChange: (value) => setForm((current) => ({ ...current, port: value })),
        }),
        Field({
          label: '访问密码',
          hint: '留空表示保持现有密码。修改密码会立即生效，并让所有已登录的局域网设备退出。',
          type: 'password',
          value: form.password,
          disabled,
          autoComplete: 'new-password',
          placeholder: view.hasPassword ? '已设置，留空则不修改' : '尚未设置',
          onChange: (value) => setForm((current) => ({ ...current, password: value })),
        }),
        Field({
          label: 'IP 白名单',
          hint: '逗号分隔的 IPv4 CIDR；留空表示不限制来源 IP。',
          value: form.allowCidrs,
          disabled,
          onChange: (value) => setForm((current) => ({ ...current, allowCidrs: value })),
        }),
        h('div', { style: styles.actions },
          h('button', {
            style: disabled ? { ...styles.button, ...styles.buttonDisabled } : styles.button,
            onClick: save,
            disabled,
          }, saving ? '保存中…' : '保存'),
          h('button', { style: styles.button, onClick: load, disabled }, '重新读取')),
        status ? h('div', { style: { ...styles.status, ...(status.kind === 'ok' ? styles.ok : styles.error) } }, status.text) : null,
        h('div', { style: { ...styles.hint, ...styles.code } }, `配置文件：${view.configFile}`));
    }

    /**
     * Register the settings page. `slots` is the only client service needed; the
     * page reads and writes over HTTP rather than the Remote gateway.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'lan-access',
        order: 60,
        label: () => '局域网访问',
      }, LanAccessSection));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
