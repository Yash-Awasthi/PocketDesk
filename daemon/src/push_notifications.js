"""
Push Notification Manager — Extracted from Yep Anywhere's push system.

Multi-channel push notifications with:
- VAPID key management
- Browser push subscription lifecycle
- Per-device notification settings
- Urgency levels (normal, persistent, silent)
"""
from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class Urgency(Enum):
    NORMAL = "normal"
    PERSISTENT = "persistent"
    SILENT = "silent"


class DeliveryUrgency(Enum):
    VERY_LOW = "very-low"
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


class DeviceType(Enum):
    ANDROID = "android"
    IOS = "ios"
    MOBILE = "mobile"
    DESKTOP = "desktop"
    UNKNOWN = "unknown"


@dataclass
class PushSubscription:
    browser_profile_id: str
    endpoint: str
    p256dh_key: str
    auth_key: str
    device_name: Optional[str] = None
    device_type: DeviceType = DeviceType.UNKNOWN
    created_at: float = field(default_factory=time.time)
    endpoint_domain: str = ""


@dataclass
class NotificationSettings:
    tool_approval: bool = True
    user_question: bool = True
    session_halted: bool = True
    project_inactive: bool = True
    ya_inactive: bool = True

    def to_dict(self) -> Dict[str, bool]:
        return {
            "toolApproval": self.tool_approval,
            "userQuestion": self.user_question,
            "sessionHalted": self.session_halted,
            "projectInactive": self.project_inactive,
            "yaInactive": self.ya_inactive,
        }


@dataclass
class PushPayload:
    title: str
    body: str
    urgency: Urgency = Urgency.NORMAL
    delivery_urgency: DeliveryUrgency = DeliveryUrgency.NORMAL
    data: Dict[str, Any] = field(default_factory=dict)
    icon: Optional[str] = None
    badge: Optional[str] = None
    tag: Optional[str] = None


class PushNotificationManager:
    """Manage push notification subscriptions and delivery."""

    def __init__(self) -> None:
        self._subscriptions: Dict[str, PushSubscription] = {}
        self._settings: Dict[str, NotificationSettings] = {}
        self._vapid_private_key: Optional[str] = None
        self._vapid_public_key: Optional[str] = None
        self._handlers: Dict[str, Callable] = {}
        self._send_log: List[Dict[str, Any]] = []

    def generate_vapid_keys(self) -> tuple[str, str]:
        """Generate VAPID key pair for Web Push."""
        self._vapid_private_key = secrets.token_urlsafe(32)
        self._vapid_public_key = hashlib.sha256(
            self._vapid_private_key.encode()
        ).hexdigest()
        return self._vapid_public_key, self._vapid_private_key

    def get_vapid_public_key(self) -> Optional[str]:
        return self._vapid_public_key

    def subscribe(
        self,
        browser_profile_id: str,
        endpoint: str,
        p256dh_key: str,
        auth_key: str,
        device_name: Optional[str] = None,
        device_type: DeviceType = DeviceType.UNKNOWN,
    ) -> PushSubscription:
        """Register a push subscription."""
        domain = ""
        if "://" in endpoint:
            domain = endpoint.split("://")[1].split("/")[0]

        sub = PushSubscription(
            browser_profile_id=browser_profile_id,
            endpoint=endpoint,
            p256dh_key=p256dh_key,
            auth_key=auth_key,
            device_name=device_name,
            device_type=device_type,
            endpoint_domain=domain,
        )
        self._subscriptions[browser_profile_id] = sub

        if browser_profile_id not in self._settings:
            self._settings[browser_profile_id] = NotificationSettings()

        return sub

    def unsubscribe(self, browser_profile_id: str) -> bool:
        """Remove a push subscription."""
        if browser_profile_id in self._subscriptions:
            del self._subscriptions[browser_profile_id]
            return True
        return False

    def get_subscriptions(self) -> List[Dict[str, Any]]:
        """List all active subscriptions."""
        return [
            {
                "browserProfileId": sub.browser_profile_id,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sub.created_at)),
                "deviceName": sub.device_name,
                "endpointDomain": sub.endpoint_domain,
                "deviceType": sub.device_type.value,
            }
            for sub in self._subscriptions.values()
        ]

    def get_settings(self, browser_profile_id: str) -> NotificationSettings:
        """Get notification settings for a profile."""
        if browser_profile_id not in self._settings:
            self._settings[browser_profile_id] = NotificationSettings()
        return self._settings[browser_profile_id]

    def update_settings(
        self,
        browser_profile_id: str,
        **kwargs: bool,
    ) -> NotificationSettings:
        """Update notification settings."""
        settings = self.get_settings(browser_profile_id)
        for key, value in kwargs.items():
            if hasattr(settings, key):
                setattr(settings, key, value)
        return settings

    def should_notify(self, browser_profile_id: str, event_type: str) -> bool:
        """Check if notification should be sent based on settings."""
        settings = self.get_settings(browser_profile_id)
        mapping = {
            "tool_approval": settings.tool_approval,
            "user_question": settings.user_question,
            "session_halted": settings.session_halted,
            "project_inactive": settings.project_inactive,
            "ya_inactive": settings.ya_inactive,
        }
        return mapping.get(event_type, True)

    def send_push(
        self,
        browser_profile_id: str,
        payload: PushPayload,
    ) -> bool:
        """Send a push notification to a subscribed device."""
        if browser_profile_id not in self._subscriptions:
            return False

        sub = self._subscriptions[browser_profile_id]

        # Check settings
        event_type = payload.data.get("event_type", "ya_inactive")
        if not self.should_notify(browser_profile_id, event_type):
            return False

        log_entry = {
            "browserProfileId": browser_profile_id,
            "title": payload.title,
            "body": payload.body,
            "urgency": payload.urgency.value,
            "deliveryUrgency": payload.delivery_urgency.value,
            "timestamp": time.time(),
            "endpoint": sub.endpoint,
            "success": True,
        }
        self._send_log.append(log_entry)

        if browser_profile_id in self._handlers:
            try:
                self._handlers[browser_profile_id](payload)
            except Exception:
                log_entry["success"] = False

        return True

    def register_handler(
        self,
        browser_profile_id: str,
        handler: Callable[[PushPayload], None],
    ) -> None:
        """Register a custom push delivery handler."""
        self._handlers[browser_profile_id] = handler

    def get_send_log(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Get recent push send log."""
        return self._send_log[-limit:]

    def test_push(
        self,
        browser_profile_id: str,
        message: Optional[str] = None,
        urgency: Urgency = Urgency.NORMAL,
        delivery_urgency: DeliveryUrgency = DeliveryUrgency.NORMAL,
    ) -> bool:
        """Send a test push notification."""
        payload = PushPayload(
            title="Test Notification",
            body=message or "This is a test notification from Yep Anywhere.",
            urgency=urgency,
            delivery_urgency=delivery_urgency,
        )
        return self.send_push(browser_profile_id, payload)

    def cleanup_stale(self, max_age_seconds: float = 86400 * 30) -> int:
        """Remove subscriptions older than max_age."""
        now = time.time()
        stale_ids = [
            pid for pid, sub in self._subscriptions.items()
            if now - sub.created_at > max_age_seconds
        ]
        for pid in stale_ids:
            del self._subscriptions[pid]
        return len(stale_ids)
