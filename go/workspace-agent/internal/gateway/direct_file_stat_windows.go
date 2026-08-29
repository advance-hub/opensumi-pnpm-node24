//go:build windows

package gateway

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const windowsToUnixEpochTicks = int64(116_444_736_000_000_000)

type windowsFileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

func fileTimesMillis(filePath string, _ os.FileInfo) (int64, int64, bool) {
	path, err := windows.UTF16PtrFromString(filePath)
	if err != nil {
		return 0, 0, false
	}
	handle, err := windows.CreateFile(
		path,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return 0, 0, false
	}
	defer windows.CloseHandle(handle)
	var info windowsFileBasicInfo
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		return 0, 0, false
	}
	return windowsFileTimeMillis(info.LastWriteTime), windowsFileTimeMillis(info.ChangeTime), true
}

func windowsFileTimeMillis(fileTimeTicks int64) int64 {
	unixTicks := fileTimeTicks - windowsToUnixEpochTicks
	seconds := unixTicks / 10_000_000
	remainder := unixTicks % 10_000_000
	if remainder < 0 {
		seconds--
		remainder += 10_000_000
	}
	return nodeTimespecMillis(seconds, remainder*100)
}
