package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

const maxJavaScriptSafeInteger = int64(9_007_199_254_740_991)

type directFileStat struct {
	uri              string
	lastModification int64
	createTime       int64
	isDirectory      bool
	isSymbolicLink   bool
	children         []*directFileStat
	size             int64
	fileType         int
	realURI          string
}

type directFileStatBuildResult byte

const (
	directFileStatBuilt directFileStatBuildResult = iota + 1
	directFileStatSkipped
	directFileStatFallback
)

func buildDirectFileStatJSON(uri fileURIComponents, filePath string, maxBytes int64) ([]byte, bool) {
	if maxBytes <= 256 {
		return nil, false
	}
	budget := maxBytes - 256
	stat, result := buildDirectFileStat(uri, filePath, 1, &budget)
	if result != directFileStatBuilt {
		return nil, false
	}
	var encoded bytes.Buffer
	stat.writeJSON(&encoded)
	if int64(encoded.Len()) > maxBytes-256 {
		return nil, false
	}
	return encoded.Bytes(), true
}

func buildDirectFileStat(
	uri fileURIComponents,
	filePath string,
	depth int,
	budget *int64,
) (*directFileStat, directFileStatBuildResult) {
	info, err := os.Lstat(filePath)
	if err != nil {
		if os.IsNotExist(err) || os.IsPermission(err) {
			return nil, directFileStatSkipped
		}
		return nil, directFileStatFallback
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return buildDirectFileStatFromInfo(uri, filePath, info, depth, budget)
	}
	realPath, err := filepath.EvalSymlinks(filePath)
	if err != nil {
		return nil, directFileStatSkipped
	}
	realPath, err = filepath.Abs(realPath)
	if err != nil {
		return nil, directFileStatFallback
	}
	realURI, ok := fileURIFromLocalPath(realPath)
	if !ok {
		return nil, directFileStatFallback
	}
	realInfo, err := os.Lstat(realPath)
	if err != nil {
		if os.IsNotExist(err) || os.IsPermission(err) {
			return nil, directFileStatSkipped
		}
		return nil, directFileStatFallback
	}
	stat, result := buildDirectFileStatFromInfo(realURI, realPath, realInfo, depth, budget)
	if result != directFileStatBuilt {
		return nil, result
	}
	stat.realURI = stat.uri
	stat.uri = uri.string()
	stat.fileType = 64
	stat.isSymbolicLink = true
	return stat, directFileStatBuilt
}

func buildDirectFileStatFromInfo(
	uri fileURIComponents,
	filePath string,
	info os.FileInfo,
	depth int,
	budget *int64,
) (*directFileStat, directFileStatBuildResult) {
	uriString := uri.string()
	if uriString == "" || !consumeDirectFileStatBudget(budget, int64(len(uriString))*6+512) {
		return nil, directFileStatFallback
	}
	lastModification, createTime, ok := fileTimesMillis(filePath, info)
	if !ok {
		return nil, directFileStatFallback
	}
	stat := &directFileStat{
		uri:              uriString,
		lastModification: lastModification,
		createTime:       createTime,
		isDirectory:      info.IsDir(),
		isSymbolicLink:   false,
		size:             info.Size(),
		fileType:         0,
	}
	if info.IsDir() {
		stat.fileType = 2
		stat.children = make([]*directFileStat, 0)
		if depth == 0 {
			return stat, directFileStatBuilt
		}
		directory, err := os.Open(filePath)
		if err != nil {
			return nil, directFileStatFallback
		}
		defer directory.Close()
		for {
			entries, readErr := directory.ReadDir(256)
			for _, entry := range entries {
				childURI := uri.child(entry.Name())
				child, result := buildDirectFileStat(
					childURI,
					filepath.Join(filePath, entry.Name()),
					depth-1,
					budget,
				)
				switch result {
				case directFileStatBuilt:
					stat.children = append(stat.children, child)
				case directFileStatSkipped:
					continue
				default:
					return nil, directFileStatFallback
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					return nil, directFileStatFallback
				}
				break
			}
		}
		sort.Slice(stat.children, func(left, right int) bool {
			return stat.children[left].uri < stat.children[right].uri
		})
		return stat, directFileStatBuilt
	}
	if info.Mode().IsRegular() {
		stat.fileType = 1
	}
	if stat.size < 0 || stat.size > maxJavaScriptSafeInteger {
		return nil, directFileStatFallback
	}
	return stat, directFileStatBuilt
}

// Node exposes file times through JavaScript Date values. Its fs binding rounds
// the nanosecond fraction to the nearest millisecond before constructing those
// values, whereas time.Time.UnixMilli truncates it. Keep the wire result byte
// compatible with DiskFileSystemProvider.stat, including the sub-millisecond
// boundary case.
func nodeTimespecMillis(seconds, nanoseconds int64) int64 {
	return seconds*1000 + (nanoseconds+500_000)/1_000_000
}

func consumeDirectFileStatBudget(budget *int64, amount int64) bool {
	if amount < 0 || *budget < amount {
		return false
	}
	*budget -= amount
	return true
}

func (uri fileURIComponents) string() string {
	if uri.scheme != "file" || uri.path == "" || uri.query != "" || uri.fragment != "" {
		return ""
	}
	return (&url.URL{Scheme: uri.scheme, Host: uri.authority, Path: uri.path}).String()
}

func (uri fileURIComponents) child(name string) fileURIComponents {
	uri.path = pathpkg.Join(uri.path, name)
	return uri
}

func fileURIFromLocalPath(filePath string) (fileURIComponents, bool) {
	cleaned := filepath.Clean(filePath)
	if !filepath.IsAbs(cleaned) {
		return fileURIComponents{}, false
	}
	if runtime.GOOS != "windows" {
		return fileURIComponents{scheme: "file", path: filepath.ToSlash(cleaned)}, true
	}
	if strings.HasPrefix(cleaned, `\\`) {
		unc := strings.TrimPrefix(filepath.ToSlash(cleaned), "//")
		separator := strings.IndexByte(unc, '/')
		if separator <= 0 {
			return fileURIComponents{}, false
		}
		return fileURIComponents{scheme: "file", authority: unc[:separator], path: unc[separator:]}, true
	}
	slashed := filepath.ToSlash(cleaned)
	if len(slashed) < 2 || slashed[1] != ':' {
		return fileURIComponents{}, false
	}
	return fileURIComponents{scheme: "file", path: "/" + slashed}, true
}

func (stat *directFileStat) writeJSON(writer *bytes.Buffer) {
	writer.WriteByte('{')
	writeJSONKeyString(writer, "uri", stat.uri, false)
	writeJSONKeyInt(writer, "lastModification", stat.lastModification, true)
	writeJSONKeyInt(writer, "createTime", stat.createTime, true)
	if stat.isDirectory {
		writeJSONKeyBool(writer, "isDirectory", true, true)
		writeJSONKeyBool(writer, "isSymbolicLink", stat.isSymbolicLink, true)
		writer.WriteString(`,"children":[`)
		for index, child := range stat.children {
			if index > 0 {
				writer.WriteByte(',')
			}
			child.writeJSON(writer)
		}
		writer.WriteByte(']')
	} else {
		writeJSONKeyBool(writer, "isSymbolicLink", stat.isSymbolicLink, true)
		writeJSONKeyBool(writer, "isDirectory", false, true)
		writeJSONKeyInt(writer, "size", stat.size, true)
	}
	writeJSONKeyInt(writer, "type", int64(stat.fileType), true)
	if stat.realURI != "" {
		writeJSONKeyString(writer, "realUri", stat.realURI, true)
	}
	writer.WriteByte('}')
}

func writeJSONKeyString(writer *bytes.Buffer, key, value string, comma bool) {
	writeJSONKey(writer, key, comma)
	encoded, _ := json.Marshal(value)
	writer.Write(encoded)
}

func writeJSONKeyInt(writer *bytes.Buffer, key string, value int64, comma bool) {
	writeJSONKey(writer, key, comma)
	writer.WriteString(strconv.FormatInt(value, 10))
}

func writeJSONKeyBool(writer *bytes.Buffer, key string, value, comma bool) {
	writeJSONKey(writer, key, comma)
	writer.WriteString(strconv.FormatBool(value))
}

func writeJSONKey(writer *bytes.Buffer, key string, comma bool) {
	if comma {
		writer.WriteByte(',')
	}
	encoded, _ := json.Marshal(key)
	writer.Write(encoded)
	writer.WriteByte(':')
}
