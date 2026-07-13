/**
 * PolicyEditor — 実 UserPolicy エディタ (Phase 8.30、§6.4)
 *
 * SettingsDrawer のローカル state だけの "Policy" 行を置き換える本物のエディタ。
 * GET した UserPolicy を編集し、変更差分だけを `PATCH /user-policy` で永続化する。
 * approval_mode=auto は「AI を無人で arm する」トグルなので、選択時に強警告を出す
 * (§4.6 fail-closed 思想 / §11.6)。金額は §4.5 の numeric helper で検証する。
 *
 * v1 の editable: approval_mode / max_tx_amount / min_tvl / min_risk_score /
 * max_daily_executions / max_lock_days / enabled_protocols / enabled_assets /
 * enabled_categories。protocol/asset の選択肢は live menu 由来 (screen が渡す)。
 */

import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import {
  ApprovalMode,
  PositionCategory,
  type UserPolicy,
} from "@workspace/lib/types";
import { isValidUsdAmount } from "@workspace/lib/utils/numeric";

const APPROVAL_MODES = Object.values(ApprovalMode);
const CATEGORIES = Object.values(PositionCategory);

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = [...b].sort();
  return [...a].sort().every((v, i) => v === sb[i]);
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export interface PolicyEditorProps {
  policy: UserPolicy;
  protocolUniverse: string[];
  assetUniverse: string[];
  onSave: (patch: Partial<UserPolicy>) => void;
  busy?: boolean;
}

export function PolicyEditor({
  policy,
  protocolUniverse,
  assetUniverse,
  onSave,
  busy = false,
}: PolicyEditorProps): React.JSX.Element {
  const [approvalMode, setApprovalMode] = useState<UserPolicy["approval_mode"]>(
    policy.approval_mode
  );
  const [maxTx, setMaxTx] = useState<string>(policy.max_tx_amount ?? "");
  const [minTvl, setMinTvl] = useState<string>(policy.min_tvl);
  const [minRisk, setMinRisk] = useState<string>(String(policy.min_risk_score));
  const [maxDaily, setMaxDaily] = useState<string>(
    policy.max_daily_executions === null
      ? ""
      : String(policy.max_daily_executions)
  );
  const [maxLock, setMaxLock] = useState<string>(
    policy.max_lock_days === null ? "" : String(policy.max_lock_days)
  );
  const [protocols, setProtocols] = useState<string[]>(policy.enabled_protocols);
  const [assets, setAssets] = useState<string[]>(policy.enabled_assets);
  const [categories, setCategories] = useState<string[]>(
    policy.enabled_categories
  );
  const [error, setError] = useState<string | null>(null);

  const protocolChoices = Array.from(
    new Set([...protocolUniverse, ...policy.enabled_protocols])
  ).sort();
  const assetChoices = Array.from(
    new Set([...assetUniverse, ...policy.enabled_assets])
  ).sort();

  const handleSave = (): void => {
    setError(null);
    // §4.5: USD 値検証
    const maxTxVal = maxTx.trim() === "" ? null : maxTx.trim();
    if (maxTxVal !== null && !isValidUsdAmount(maxTxVal)) {
      setError("最大 tx 額は USD 8-dec の数値 (例 20.00000000) か空 (無制限)");
      return;
    }
    if (!isValidUsdAmount(minTvl.trim())) {
      setError("最小 TVL は USD 数値で入力してください");
      return;
    }
    const risk = Number(minRisk);
    if (!Number.isFinite(risk) || risk < 0 || risk > 1) {
      setError("min_risk_score は 0〜1 の数値");
      return;
    }
    const daily = maxDaily.trim() === "" ? null : Number(maxDaily);
    if (daily !== null && (!Number.isInteger(daily) || daily < 0)) {
      setError("max_daily_executions は 0 以上の整数か空");
      return;
    }
    const lock = maxLock.trim() === "" ? null : Number(maxLock);
    if (lock !== null && (!Number.isInteger(lock) || lock < 0)) {
      setError("max_lock_days は 0 以上の整数か空");
      return;
    }
    if (protocols.length === 0 || assets.length === 0) {
      setError("enabled_protocols / enabled_assets を 1 つ以上選択してください");
      return;
    }

    // 変更差分のみ patch
    const patch: Partial<UserPolicy> = {};
    if (approvalMode !== policy.approval_mode) patch.approval_mode = approvalMode;
    if (maxTxVal !== policy.max_tx_amount) patch.max_tx_amount = maxTxVal;
    if (minTvl.trim() !== policy.min_tvl) patch.min_tvl = minTvl.trim();
    if (risk !== policy.min_risk_score) patch.min_risk_score = risk;
    if (daily !== policy.max_daily_executions) patch.max_daily_executions = daily;
    if (lock !== policy.max_lock_days) patch.max_lock_days = lock;
    if (!sameArray(protocols, policy.enabled_protocols))
      patch.enabled_protocols = protocols;
    if (!sameArray(assets, policy.enabled_assets)) patch.enabled_assets = assets;
    if (!sameArray(categories, policy.enabled_categories))
      patch.enabled_categories = categories as UserPolicy["enabled_categories"];

    onSave(patch);
  };

  const armed = approvalMode === ApprovalMode.Auto;

  return (
    <View style={styles.card} testID="policy-editor">
      <Text style={styles.title}>ポリシー (AI が動ける範囲)</Text>

      {/* approval_mode */}
      <Text style={styles.fieldLabel}>承認モード</Text>
      <View style={styles.modeRow}>
        {APPROVAL_MODES.map((m) => (
          <Pressable
            key={m}
            accessibilityRole="button"
            onPress={() => setApprovalMode(m)}
            style={[styles.modeChip, approvalMode === m && styles.modeChipOn]}
            testID={`policy-mode-${m}`}
          >
            <Text
              style={[
                styles.modeChipText,
                approvalMode === m && styles.modeChipTextOn,
              ]}
            >
              {m}
            </Text>
          </Pressable>
        ))}
      </View>

      {armed && (
        <View style={styles.warnBox} testID="policy-auto-warning">
          <Text style={styles.warnText}>
            ⚠ auto = 人のタップなしで AI が実行します (feature flag ON かつ devnet
            時)。ハード上限内・policy 内に限られますが、無人実行が有効になります。
          </Text>
        </View>
      )}

      {/* numeric caps */}
      <NumField
        label="最大 tx 額 (USD、空=無制限)"
        value={maxTx}
        onChange={setMaxTx}
        placeholder="20.00000000"
        testID="policy-max-tx"
      />
      <NumField
        label="最小 TVL (USD)"
        value={minTvl}
        onChange={setMinTvl}
        placeholder="1000000"
        testID="policy-min-tvl"
      />
      <NumField
        label="min_risk_score (0〜1)"
        value={minRisk}
        onChange={setMinRisk}
        placeholder="0.5"
        testID="policy-min-risk"
      />
      <NumField
        label="1 日の最大実行数 (空=無制限)"
        value={maxDaily}
        onChange={setMaxDaily}
        placeholder="5"
        testID="policy-max-daily"
      />
      <NumField
        label="最大 lock 日数 (空=無制限)"
        value={maxLock}
        onChange={setMaxLock}
        placeholder="0"
        testID="policy-max-lock"
      />

      {/* enable lists */}
      <ChipGroup
        label="protocols"
        choices={protocolChoices}
        selected={protocols}
        onToggle={(v) => setProtocols((p) => toggle(p, v))}
        testIDPrefix="policy-protocol"
      />
      <ChipGroup
        label="assets"
        choices={assetChoices}
        selected={assets}
        onToggle={(v) => setAssets((a) => toggle(a, v))}
        testIDPrefix="policy-asset"
      />
      <ChipGroup
        label="categories"
        choices={CATEGORIES}
        selected={categories}
        onToggle={(v) => setCategories((c) => toggle(c, v))}
        testIDPrefix="policy-category"
      />

      {error && (
        <Text style={styles.error} testID="policy-error">
          {error}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={handleSave}
        style={[styles.saveCta, busy && styles.disabled]}
        testID="policy-save"
      >
        <Text style={styles.saveCtaText}>{busy ? "保存中…" : "ポリシーを保存"}</Text>
      </Pressable>
    </View>
  );
}

function NumField({
  label,
  value,
  onChange,
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={COLOR.textMuted}
        keyboardType="decimal-pad"
        style={styles.input}
        testID={testID}
      />
    </View>
  );
}

function ChipGroup({
  label,
  choices,
  selected,
  onToggle,
  testIDPrefix,
}: {
  label: string;
  choices: string[];
  selected: string[];
  onToggle: (value: string) => void;
  testIDPrefix: string;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipWrap}>
        {choices.map((c) => {
          const on = selected.includes(c);
          return (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onToggle(c)}
              style={[styles.chip, on && styles.chipOn]}
              testID={`${testIDPrefix}-${c}`}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{c}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLOR.textOnColor,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLOR.border,
    padding: SPACE.md,
    gap: SPACE.sm,
  },
  title: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.headingMD,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  field: { gap: SPACE.xs },
  fieldLabel: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
  },
  modeRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
  modeChip: {
    borderWidth: 1,
    borderColor: COLOR.borderStrong,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
  },
  modeChipOn: { backgroundColor: COLOR.sodaText, borderColor: COLOR.sodaText },
  modeChipText: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.textSubtitle,
  },
  modeChipTextOn: { color: COLOR.textOnColor, fontWeight: WEIGHT.bold },
  warnBox: {
    backgroundColor: withAlpha(COLOR.cherryDark, 0.08),
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.cherryDark,
    padding: SPACE.sm,
  },
  warnText: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.cherryDark,
  },
  input: {
    borderWidth: 1,
    borderColor: COLOR.borderStrong,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.sm,
    fontFamily: FONT.mono,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textPrimary,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
  chip: {
    borderWidth: 1,
    borderColor: COLOR.borderStrong,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
  },
  chipOn: { backgroundColor: COLOR.melonText, borderColor: COLOR.melonText },
  chipText: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.textSubtitle,
  },
  chipTextOn: { color: COLOR.textOnColor, fontWeight: WEIGHT.semibold },
  error: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.cherryDark,
  },
  saveCta: {
    marginTop: SPACE.sm,
    borderRadius: RADIUS.md,
    paddingVertical: SPACE.sm + 2,
    alignItems: "center",
    backgroundColor: COLOR.sodaText,
  },
  saveCtaText: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.bodyLG,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  disabled: { opacity: 0.5 },
});
