package ports

type UserRepository interface {
	FindByID(id string) error
}
