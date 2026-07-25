include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mullvad
PKG_VERSION:=1.0.1
PKG_RELEASE:=1
PKG_LICENSE:=MIT

LUCI_TITLE:=Mullvad VPN manager with relay selection, latency probing and failover
LUCI_DEPENDS:=+luci-base +luci-proto-wireguard +wireguard-tools
LUCI_PKGARCH:=all

define Package/luci-app-mullvad/conffiles
/etc/config/mullvad
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
