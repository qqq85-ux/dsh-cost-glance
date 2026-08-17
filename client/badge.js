window.__ModuleLoader__.load({
	id: "dsh-cost-glance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region locales
		const NS = "costGlance";
		const zh = {
			"badge.empty": "约 ¥0.00",
			"badge.unpriced": "费用 —",
			"badge.priced": "约 {amount}",
			"popover.title": "当前会话费用速览",
			"popover.estimated": "本会话预估",
			"popover.hit": "缓存命中输入",
			"popover.miss": "缓存未命中输入",
			"popover.output": "输出",
			"popover.model": "模型",
			"popover.period": "当前计价",
			"popover.rule": "价格规则版本",
			"popover.updated": "最后更新",
			"popover.period.peak": "高峰",
			"popover.period.offPeak": "闲时",
			"popover.period.flat": "非峰谷价",
			"popover.note": "本地预估，以 DeepSeek 官方账单为准",
			"popover.unpriced": "当前 Provider 未配置官方计价规则",
			"popover.reason.non-deepseek-provider": "非 DeepSeek 官方 API，不套用官方价",
			"popover.reason.model-not-in-official-table": "模型不在 DeepSeek 官方价格表",
			"popover.reason.no-applicable-rule": "该时刻无适用价格规则",
			"popover.reason.usage-missing": "调用未返回 usage，无法精确计价",
			"popover.reason.cache-miss-missing": "缺少缓存未命中 token，无法精确计价",
			"popover.reason.cache-hit-missing": "缺少缓存命中 token，无法精确计价",
			"popover.reason.output-missing": "缺少输出 token，无法精确计价",
			"popover.reason.no-event-time": "缺少可信事件时间，无法选价",
			"popover.ruleStale": "价格规则待确认",
			"popover.nano": "核验（6 位小数）"
		};
		const en = {
			"badge.empty": "≈ ¥0.00",
			"badge.unpriced": "Cost —",
			"badge.priced": "≈ {amount}",
			"popover.title": "Session cost glance",
			"popover.estimated": "Session estimate",
			"popover.hit": "Cache-hit input",
			"popover.miss": "Cache-miss input",
			"popover.output": "Output",
			"popover.model": "Model",
			"popover.period": "Period",
			"popover.rule": "Pricing rule",
			"popover.updated": "Updated",
			"popover.period.peak": "Peak",
			"popover.period.offPeak": "Off-peak",
			"popover.period.flat": "Flat",
			"popover.note": "Local estimate; DeepSeek official billing prevails",
			"popover.unpriced": "No official pricing rule for this provider",
			"popover.reason.non-deepseek-provider": "Not DeepSeek official API",
			"popover.reason.model-not-in-official-table": "Model not on DeepSeek official price list",
			"popover.reason.no-applicable-rule": "No pricing rule for this moment",
			"popover.reason.usage-missing": "No usage reported; cannot price exactly",
			"popover.reason.cache-miss-missing": "Cache-miss tokens missing",
			"popover.reason.cache-hit-missing": "Cache-hit tokens missing",
			"popover.reason.output-missing": "Output tokens missing",
			"popover.reason.no-event-time": "No trusted event time",
			"popover.ruleStale": "Pricing rules need confirmation",
			"popover.nano": "Verify (6 decimals)"
		};
		//#endregion
		//#region helpers
		/**
		* 相对时间：<60s=刚刚；<60m=X 分钟前；<24h=X 小时前；否则 YYYY-MM-DD HH:MM。
		* @param epochMs - 事件时间。
		* @returns 展示字符串。
		*/
		function relativeTime(epochMs) {
			if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "—";
			const diff = Date.now() - epochMs;
			if (diff < 60 * 1000) return "刚刚";
			if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
			if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
			const d = new Date(epochMs);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** 未计价原因 → 展示文案。 */
		function reasonText(reason, t) {
			const key = `popover.reason.${reason}`;
			return t(key) !== key ? t(key) : t("popover.unpriced");
		}
		//#endregion
		//#region CostBadge + Popover
		/**
		* 顶栏费用徽标：显示当前会话预估费用（约 ¥X.XX）。点击弹出费用构成。
		* 克制风格：无状态点、无强阴影、无动画。
		* @param props - 插槽标准注入（sessionId / useProjection / t）。
		*/
		function CostBadge(props) {
			const { sessionId, useProjection, t } = props;
			const glance = useProjection("costGlance");
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			// 切换会话立即关闭 Popover，并跟随新会话数据
			react.useEffect(() => {
				setOpen(false);
			}, [sessionId]);
			// 点击外部 / Escape 关闭
			react.useEffect(() => {
				if (!open) return;
				const onDown = (e) => {
					if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			const status = glance?.status ?? "empty";
			let label;
			if (status === "priced") label = t("badge.priced", { amount: glance.estimated });
			else if (status === "unpriced") label = t("badge.unpriced");
			else label = t("badge.empty");

			const badgeStyle = {
				display: "inline-flex",
				alignItems: "center",
				height: "28px",
				padding: "0 10px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.06))",
				color: "var(--dsw-alias-label-secondary, inherit)",
				fontSize: "12px",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
				cursor: "pointer",
				userSelect: "none"
			};
			const popoverStyle = {
				position: "absolute",
				top: "calc(100% + 8px)",
				right: "0",
				zIndex: 60,
				minWidth: "240px",
				boxSizing: "border-box",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.35))",
				background: "var(--dsw-specific-menu, #ffffff)",
				color: "var(--dsw-alias-label-primary, inherit)",
				boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
				fontSize: "12px",
				lineHeight: "1.7",
				padding: "10px 12px"
			};
			const rowStyle = {
				display: "flex",
				justifyContent: "space-between",
				gap: "16px"
			};
			const keyStyle = { color: "var(--dsw-alias-label-tertiary, #888)" };
			const valStyle = { fontVariantNumeric: "tabular-nums", textAlign: "right" };
			const rows = (cells) => cells.map(([k, v], i) => react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsx("span", { style: keyStyle, children: k }),
				react_jsx_runtime.jsx("span", { style: valStyle, children: v })
			] }, i));
			const noteStyle = {
				marginTop: "8px",
				paddingTop: "8px",
				borderTop: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))",
				color: "var(--dsw-alias-label-tertiary, #888)",
				fontSize: "11px"
			};

			let popover = null;
			if (open) {
				const period = glance?.pricingPeriod ?? "—";
				const ruleVersion = glance?.pricingRuleVersion ?? "—";
				const model = glance?.model ?? "—";
				const unpricedLine = (glance?.unpricedReasons ?? []).map((u) =>
					`${u.model}: ${reasonText(u.reason, t)}`).join("；");
				const nanoLine = (glance?.estimatedNano ?? 0) / 1e9;
				popover = react_jsx_runtime.jsx("div", {
					style: popoverStyle,
					role: "dialog",
					"aria-label": t("popover.title"),
					children: [
						react_jsx_runtime.jsx("div", { style: { fontWeight: 600, marginBottom: "6px", fontSize: "12px" }, children: t("popover.title") }),
						status === "unpriced" || status === "empty" && (glance?.unpricedReasons ?? []).length > 0
							? react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", marginBottom: "4px" }, children: unpricedLine })
							: null,
						status === "priced" ? rows([
							[t("popover.estimated"), glance.estimated],
							[t("popover.hit"), glance.hit],
							[t("popover.miss"), glance.miss],
							[t("popover.output"), glance.output],
							[t("popover.model"), model],
							[t("popover.period"), t(`popover.period.${glance.pricingPeriod === "高峰" ? "peak" : glance.pricingPeriod === "闲时" ? "offPeak" : "flat"}`)],
							[t("popover.rule"), ruleVersion],
							[t("popover.updated"), relativeTime(glance.lastUpdatedAt)]
						]) : null,
						status === "priced" ? react_jsx_runtime.jsx("div", {
							style: { ...noteStyle, ...{ marginTop: "6px", paddingTop: "6px" } },
							children: `${t("popover.nano")}: ${nanoLine.toFixed(6)}`
						}) : null,
						glance?.ruleStale ? react_jsx_runtime.jsx("div", { style: { color: "#b7791f", marginTop: "4px" }, children: t("popover.ruleStale") }) : null,
						react_jsx_runtime.jsx("div", { style: noteStyle, children: t("popover.note") })
					]
				});
			}

			return react_jsx_runtime.jsx("div", {
				ref: rootRef,
				style: { position: "relative", display: "inline-flex" },
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						style: badgeStyle,
						"aria-expanded": open,
						onClick: (e) => {
							e.stopPropagation();
							setOpen((v) => !v);
						},
						title: t("popover.title"),
						children: label
					}, "badge"),
					popover
				]
			});
		}
		//#endregion
		//#region index
		const inject = [
			"slots",
			"locale"
		];
		/**
		* 插件主体：注册字典 + 顶栏费用徽标。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-cost-glance: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "dsh-cost-glance",
				order: 10,
				locale: NS
			}, CostBadge));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
