import React, { useEffect, useState } from 'react';
import { ChoiceList, TagChoices } from './library-ui.jsx';

export function useCatalogue(api, enabled, options, page, revision, onError, reload) {
  const selectionKey = JSON.stringify([enabled, options, revision]);
  const key = JSON.stringify([selectionKey, page, reload]);
  const [result, setResult] = useState(null),
    [choice, setChoice] = useState(null);
  useEffect(() => setChoice(null), [selectionKey]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api
      .listWorks({ ...options, page })
      .then((report) => {
        if (current) setResult({ key, report });
      })
      .catch((error) => {
        if (current) {
          setResult({ key, report: null });
          onError(error.message);
        }
      });
    return () => {
      current = false;
    };
  }, [enabled, key]);
  const report = result?.key === key ? result.report : null;
  const active = !!report && choice?.scope === report.scope;
  const all = active && choice.all;
  const ids = active ? choice.ids : new Set();
  function mark(members, checked) {
    if (!report) return;
    const next = new Set(ids);
    for (const id of members) {
      if (checked !== all) next.add(id);
      else next.delete(id);
    }
    setChoice({ scope: report.scope, all, ids: next });
  }
  return {
    report,
    pending: enabled && result?.key !== key,
    has: (id) => active && (all ? !ids.has(id) : ids.has(id)),
    count: active ? (all ? report.total - ids.size : ids.size) : 0,
    mark,
    selectAll() {
      if (report) setChoice({ scope: report.scope, all: true, ids: new Set() });
    },
    clear() {
      setChoice(null);
    },
    selection: active
      ? { ...options, scope: choice.scope, revision: report.revision, all, ids: [...ids] }
      : null
  };
}

export function CatalogueChoices({ api, source, kind, value, onChange, mode, onMode, onError }) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [loaded, setLoaded] = useState(null);
  const key = JSON.stringify([source, kind, query, page]);
  useEffect(() => {
    let current = true;
    api
      .catalogueChoices({ source, kind, query, page })
      .then((report) => {
        if (current) setLoaded({ key, report });
      })
      .catch((error) => {
        if (current) onError(error.message);
      });
    return () => {
      current = false;
    };
  }, [key]);
  const report = loaded?.key === key ? loaded.report : null,
    items = report?.items ?? [];
  const search = {
    search: query,
    onSearch: (text) => {
      setQuery(text);
      setPage(1);
    }
  };
  return (
    <>
      {kind === 'authors' ? (
        <ChoiceList
          {...search}
          values={query ? items : [['', '所有作者'], ...items]}
          selected={value}
          onChange={(id) => onChange(id, items.find(([key]) => key === id)?.[1] || '所有作者')}
        />
      ) : (
        <TagChoices
          {...search}
          values={items.map(([id]) => id)}
          selected={value}
          onChange={onChange}
          mode={mode}
          onMode={onMode}
        />
      )}
      {(page > 1 || report?.hasMore) && (
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>{page}</span>
          <button disabled={!report?.hasMore} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </>
  );
}
