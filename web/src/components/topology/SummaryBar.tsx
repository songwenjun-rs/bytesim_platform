import type { HwSpecBody } from "../../api/specs";

export function SummaryBar({ body }: { body: HwSpecBody }) {
  const clusters = body.datacenter?.clusters ?? [];
  const racks = clusters.flatMap((c) => c.racks);
  const totalGPU = racks.reduce((a, r) => a + r.servers.reduce((s, srv) => s + srv.gpu_count, 0), 0);
  const totalSrv = racks.reduce((a, r) => a + r.servers.length, 0);
  const peakKw = racks.reduce(
    (a, r) => a + r.servers.reduce((s, srv) => s + srv.tdp_kw * srv.gpu_count / 8, 0),
    0,
  );
  return (
    <div className="summary-bar">
      <div><span className="lab">峰值功率</span><strong>{peakKw.toFixed(0)} kW</strong></div>
      <div><span className="lab">集群</span><strong>{clusters.length}</strong></div>
      <div><span className="lab">机柜</span><strong>{racks.length}</strong></div>
      <div><span className="lab">服务器</span><strong>{totalSrv}</strong></div>
      <div><span className="lab">GPU 卡数</span><strong>{totalGPU}</strong></div>
    </div>
  );
}
