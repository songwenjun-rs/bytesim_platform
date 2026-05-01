/**
 * 硬件部件 + sim 模板 — 统一走 BFF /v1/catalog/items/{kind}, 后端 bs_catalog
 * 表持久化。前端不再读 localStorage。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch, getJSON } from "./client";

export type CatalogKind = "cpu" | "gpu" | "nic" | "ssd" | "train_preset" | "infer_preset";

export type CatalogItem<B = Record<string, unknown>> = {
  kind: CatalogKind;
  id: string;
  name: string;
  body: B;
};

export function useCatalogItems<B = Record<string, unknown>>(kind: CatalogKind) {
  return useQuery({
    queryKey: ["catalog-items", kind],
    queryFn: () => getJSON<CatalogItem<B>[]>(`/v1/catalog/items/${kind}`),
    staleTime: 30_000,
  });
}

export function useUpsertCatalogItem(kind: CatalogKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { id?: string; name: string; body: unknown }) => {
      const url = body.id
        ? `/v1/catalog/items/${kind}/${body.id}`
        : `/v1/catalog/items/${kind}`;
      const r = await authFetch(url, {
        method: body.id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<CatalogItem>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-items", kind] }),
  });
}

export function useDeleteCatalogItem(kind: CatalogKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await authFetch(`/v1/catalog/items/${kind}/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`${r.status} ${await r.text()}`);
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-items", kind] }),
  });
}
