package validators

import (
	"strings"
)

// NotBlank validates that a string is not empty or whitespace-only
func NotBlank(val string) bool {
	return len(strings.TrimSpace(val)) > 0
}
