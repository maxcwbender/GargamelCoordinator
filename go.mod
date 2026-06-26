module gargamel-lobby-manager

go 1.25

require (
	github.com/paralin/go-dota2 v0.0.0-20260418225115-803efa07c070
	github.com/paralin/go-steam v0.0.0-20260416001652-4b80b1117268
	github.com/sirupsen/logrus v1.9.4
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	golang.org/x/sys v0.40.0 // indirect
)

replace github.com/paralin/go-steam => github.com/markus-wa/go-steam v0.0.0-20260610202143-f5bec258c2c6
