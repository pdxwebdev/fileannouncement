"""
YadaCoin Open Source License (YOSL) v1.1

Copyright (c) 2017-2025 Matthew Vogel, Reynold Vogel, Inc.

This software is licensed under YOSL v1.1 – for personal and research use only.
NO commercial use, NO blockchain forks, and NO branding use without permission.

For commercial license inquiries, contact: info@yadacoin.io

Full license terms: see LICENSE.txt in this repository.
"""

import unittest
from pathlib import Path

_DEMO_DIR = Path(__file__).resolve().parent.parent / "demos" / "yadascrollerdemo"


class TestYadaScrollerProfileNav(unittest.TestCase):
    def _read(self, name):
        with open(_DEMO_DIR / name, encoding="utf-8") as fh:
            return fh.read()

    def test_bottom_right_button_uses_avatar(self):
        html = self._read("index.html")
        self.assertIn('id="nav-profile"', html)
        self.assertIn('class="tab tab-avatar"', html)
        self.assertIn('id="nav-profile-avatar"', html)
        self.assertIn('class="nav-avatar"', html)
        self.assertNotIn(
            '<button type="button" id="nav-profile" class="tab">Profile</button>',
            html,
        )

    def test_avatar_uses_profile_photo_or_blank_fallback(self):
        src = self._read("app.js")
        self.assertIn("function paintNavAvatar", src)
        self.assertIn("function refreshNavProfile", src)
        self.assertIn("profileAvatarSrc(profile)", src)
        self.assertIn('avatarMarkup("")', src)

    def test_avatar_routes_to_profile_or_signin(self):
        src = self._read("app.js")
        self.assertIn("account.username", src)
        self.assertIn('location.hash = "#/me"', src)

    def test_avatar_has_styles(self):
        css = self._read("styles.css")
        self.assertIn(".tabbar .tab-avatar", css)
        self.assertIn(".nav-avatar", css)
