"""
AgentMemory Python SDK

Usage:
    from agentmemory import AgentMemory

    memory = AgentMemory(api_key="am_...")
    memory.store("my-project", "db-schema", "Users table has id, email, name columns")
    results = memory.search("my-project", "database schema")
"""

from __future__ import annotations

import os
from typing import Any

import httpx


DEFAULT_BASE_URL = "https://api.agentmemory.dev"


class AgentMemory:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        namespace: str = "default",
    ):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key or os.environ.get("AGENTMEMORY_API_KEY", "")
        self.default_namespace = namespace
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            timeout=30.0,
        )

    def _ns(self, namespace: str | None) -> str:
        return namespace or self.default_namespace

    def store(
        self,
        namespace: str | None,
        key: str,
        content: str,
        *,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict:
        """Store a new memory."""
        resp = self._client.post(
            "/v1/memory/store",
            json={
                "namespace": self._ns(namespace),
                "key": key,
                "content": content,
                "tags": tags or [],
                "metadata": metadata or {},
            },
        )
        resp.raise_for_status()
        return resp.json()

    def search(
        self,
        namespace: str | None,
        query: str,
        *,
        limit: int = 10,
        tags: list[str] | None = None,
    ) -> list[dict]:
        """Search memories by natural language query."""
        params = {
            "namespace": self._ns(namespace),
            "query": query,
            "limit": str(limit),
        }
        if tags:
            params["tags"] = ",".join(tags)
        resp = self._client.get("/v1/memory/search", params=params)
        resp.raise_for_status()
        return resp.json()

    def recall(
        self,
        namespace: str | None,
        key: str,
        *,
        version: int | None = None,
    ) -> dict | None:
        """Recall a specific memory by key."""
        params = {"namespace": self._ns(namespace), "key": key}
        if version is not None:
            params["version"] = str(version)
        resp = self._client.get("/v1/memory/recall", params=params)
        resp.raise_for_status()
        return resp.json()

    def update(
        self,
        namespace: str | None,
        key: str,
        content: str,
        *,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict:
        """Update an existing memory (creates a new version)."""
        body = {
            "namespace": self._ns(namespace),
            "key": key,
            "content": content,
        }
        if tags is not None:
            body["tags"] = tags
        if metadata is not None:
            body["metadata"] = metadata
        resp = self._client.put("/v1/memory/update", json=body)
        resp.raise_for_status()
        return resp.json()

    def forget(self, namespace: str | None, key: str) -> bool:
        """Delete a memory permanently."""
        resp = self._client.request(
            "DELETE",
            "/v1/memory/forget",
            json={"namespace": self._ns(namespace), "key": key},
        )
        resp.raise_for_status()
        return True

    def list(
        self,
        namespace: str | None,
        *,
        prefix: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict]:
        """List memories in a namespace."""
        params = {"namespace": self._ns(namespace)}
        if prefix:
            params["prefix"] = prefix
        if tags:
            params["tags"] = ",".join(tags)
        resp = self._client.get("/v1/memory/list", params=params)
        resp.raise_for_status()
        return resp.json()

    def namespaces(self) -> list[dict]:
        """List all namespaces."""
        resp = self._client.get("/v1/namespaces")
        resp.raise_for_status()
        return resp.json()

    def close(self):
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
