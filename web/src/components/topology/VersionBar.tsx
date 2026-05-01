/**
 * 集群配置 顶栏 —— 沿用 TrainingSim 顶栏模式（sticky + blur + 右侧主按钮），
 * 保证两个页面的「主操作按钮」位置一致。
 */
type Props = {
  saving: boolean;
  onSave: () => void;
};

export function VersionBar({ saving, onSave }: Props) {
  return (
    <>
      <div className="page-hd">
        <h1 className="page-ttl">集群配置</h1>
      </div>
      <div
        style={{
          position: "sticky", top: 0, zIndex: 100,
          marginBottom: 14,
          padding: "10px 14px",
          background: "var(--bg-2)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-md)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          backdropFilter: "blur(6px)",
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--t3)" }}>
          编辑机柜 / 服务器 / 网络后，请记得保存为新版本快照。
        </span>
        <button
          className="btn btn-primary"
          onClick={onSave}
          disabled={saving}
          style={{
            fontSize: 13, padding: "7px 18px",
            flexShrink: 0, marginLeft: "auto",
          }}
        >
          {saving ? "保存中…" : "💾 保存"}
        </button>
      </div>
    </>
  );
}
